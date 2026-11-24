import { createRebuttalComments } from './rebuttal-comments.js?v=__REBUTTAL_COMMENTS_JS_HASH__'
import { verifiedSpan, alignedResponseTranslation, replaceSharedText, mergeRoundEdit, uid } from './rebuttal-model.js'
import { translatedReadingPosition } from './rebuttal-reading-position.js?v=1'
import { createKoreanTranslation } from './rebuttal-translation.js?v=__REBUTTAL_TRANSLATION_JS_HASH__'
import { createSessionBindings, createResponseRevisionSync, createTextHashCache } from './rebuttal-session.js?v=__REBUTTAL_SESSION_JS_HASH__'
import { createSubmission, download } from './rebuttal-submission.js?v=__REBUTTAL_SUBMISSION_JS_HASH__'

const accountIds={language:'workspace-language','sync-state':'collab-label'}
const $ = id => document.getElementById(accountIds[id] || id)
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const clone = value => structuredClone(value)
let language = document.documentElement.lang === 'ko' ? 'ko' : 'en'
const t = (en, ko) => language === 'ko' ? ko : en
const slug = decodeURIComponent(location.pathname.match(/^\/p\/([^/]+)/)?.[1] || new URLSearchParams(location.search).get('project') || 'demo')
const base = `/api/rebuttal/projects/${encodeURIComponent(slug)}`
function updateWorkspaceNavigation() {
  $('manuscript-link').textContent = 'Paper'
  $('manuscript-link').href = `/p/${encodeURIComponent(slug)}?lang=${language}`
  $('open-rebuttal').textContent = 'Rebuttal'
}
updateWorkspaceNavigation()
try{const layout=JSON.parse(window.PaperPreferenceStorage?.get('paper-workspace-layout')||'{}');const width=Number(layout.sidebarWidth);if(Number.isFinite(width))document.body.style.setProperty('--project-sidebar-width',`${Math.min(320,Math.max(180,width))}px`);$('workspace-project-title').textContent=sessionStorage.getItem(`paper-project-title:${slug}`)||slug}catch{$('workspace-project-title').textContent=slug}
function applyReviewSidebar(){window.PaperUI.cancelSidebarMotion();let layout={};try{layout=JSON.parse(window.PaperPreferenceStorage?.get('paper-workspace-layout')||'{}')}catch{}const width=Number(layout.sidebarWidth);if(Number.isFinite(width)&&width>0)document.body.style.setProperty('--project-sidebar-width',`${Math.min(320,Math.max(180,width))}px`);const collapsed=Boolean(layout.sidebarCollapsed);document.body.classList.toggle('is-sidebar-collapsed',collapsed);window.PaperUI.updateSidebarToggle($('toggle-review-sidebar'),collapsed)}
let sidebarMotionGeneration=0
$('toggle-review-sidebar').onclick=()=>{const generation=++sidebarMotionGeneration;document.body.classList.add('sidebar-motion-active');window.PaperUI.animateSidebarChange(()=>{let layout={};try{layout=JSON.parse(window.PaperPreferenceStorage?.get('paper-workspace-layout')||'{}')}catch{}layout.sidebarCollapsed=!layout.sidebarCollapsed;window.PaperPreferenceStorage?.set('paper-workspace-layout',JSON.stringify(layout));applyReviewSidebar();syncReviewerSidebarControls()}).then(()=>{if(generation!==sidebarMotionGeneration)return;document.body.classList.remove('sidebar-motion-active');drawEdges()},error=>{if(generation===sidebarMotionGeneration){document.body.classList.remove('sidebar-motion-active');scheduleEdges()}console.error('Sidebar layout change failed',error);notice(t('Unable to change sidebar layout.','사이드바를 변경하지 못했습니다.'),true)})}
applyReviewSidebar()
window.addEventListener('paper-language-change',applyReviewSidebar)
const statusCenter=window.PaperSidebarAccount.createStatusPanel({onOpen:()=>renderSyncStatus()})
const readOnly = Boolean(window.PaperAccess) && !['owner', 'editor'].includes(window.PaperAccess.projects?.[slug])
const reviewLanguageKey = `paper-rebuttal-review-language:${slug}`
const answerLanguageKey = `paper-rebuttal-answer-language:${slug}`
let state = { revision: 0, rounds: [], jobs: [] }, roundId = new URLSearchParams(location.search).get('round') || location.pathname.match(/\/rebuttal\/([^/]+)/)?.[1]
let screen = ['overview', 'reviews', 'evidence', 'submission'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'reviews'
let currentDocId, currentReviewerId, koreanReview = window.PaperPreferenceStorage?.get(reviewLanguageKey)==='ko', selectedConcern, sourceSelections = [], responseSelections = []
let savedReviewRange = null
const collapsedReviewFields = new Set()
const collapsedReviewFieldsKey = `paper-rebuttal-collapsed-fields:${slug}`
try {
  const saved=JSON.parse(window.PaperPreferenceStorage?.get(collapsedReviewFieldsKey) || '[]')
  if(Array.isArray(saved))for(const key of saved.slice(0,4000))if(typeof key==='string' && key.length<=1000)collapsedReviewFields.add(key)
} catch {}
function saveCollapsedReviewFields(){window.PaperPreferenceStorage?.set(collapsedReviewFieldsKey,JSON.stringify([...collapsedReviewFields]))}
let reviewFieldIndex = 0
let responsePreview = false
let showAllConnections = false, advancedOpen = false, findingsOpen = false, checkSubmitting = false, checkJobId = null, sidebarAdvancedOpen = false
let sidebarAdvancedAnimation = null
let connectionVisibilityRound = null
// Project-scoped navigation context contains identifiers and positions, never response text.
let navigationContext={}
try{navigationContext=JSON.parse(sessionStorage.getItem(`paper-rebuttal-position:${slug}`)||'{}')}catch{}
if (!location.hash && ['overview','reviews','evidence','submission'].includes(navigationContext.screen)) screen=navigationContext.screen
if(!roundId)roundId=navigationContext.roundId
currentDocId=navigationContext.currentDocId;currentReviewerId=navigationContext.currentReviewerId
window.addEventListener('pagehide',()=>{try{sessionStorage.setItem(`paper-rebuttal-position:${slug}`,JSON.stringify({roundId,screen,currentDocId,currentReviewerId,scrollY:window.scrollY,selection:editor?.getSelection(),editorScroll:editor?.scrollDOM?.scrollTop||0}))}catch{}})
let connectionStatus='connecting'
let session, sessionReady = false, editor, busy = false, polling, dialogSubmit, metadataDirty = false
let dialogRoundSnapshot, dialogInitialValues, textBinding = Promise.resolve(), textBindingError = null
let profileActor
let reviewViewVisible = !(new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window)
let presenceTimer
const presenceColor = value => typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#2457d6'
function scheduleReviewPresence(){clearTimeout(presenceTimer);presenceTimer=setTimeout(syncReviewPresence,50)}
function syncReviewPresence(){
  clearTimeout(presenceTimer)
  const awareness=session?.provider?.awareness;if(!awareness)return
  if(!reviewViewVisible && window.parent!==window && window.parent.PaperWorkspaceSharedSession===session){renderReviewPresence();return}
  const visible=reviewViewVisible && document.visibilityState!=='hidden',focused=visible && document.hasFocus()
  const inResponse=reviewViewVisible && screen==='reviews' && Boolean(roundId && currentDocId)
  const editing=visible && focused && inResponse && answerLanguage==='en' && !responsePreview && !readOnly && Boolean(editor?.focusWithin())
  const value=inResponse?{roundId,documentId:currentDocId,editing}:null
  const shared=sharedTexts.get(documentFor()?.text_key || currentDocId)
  if(editing && shared && editor?.view){
    const {anchor,head}=editor.view.state.selection.main
    Object.assign(value,session.encodeTextRange(shared,anchor,head),{line:editor.lineAt(head).number})
  }
  const previous=awareness.getLocalState() || {},next={...previous,rebuttal:value}
  next.workspace={surface:'rebuttal',visible,focused,editing,roundId:reviewViewVisible?roundId:null,documentId:reviewViewVisible?currentDocId:null,screen:reviewViewVisible?screen:null};next.cursor=null
  if(JSON.stringify([previous.rebuttal,previous.workspace,previous.cursor])!==JSON.stringify([next.rebuttal,next.workspace,next.cursor]))awareness.setLocalState(next)
  renderReviewPresence()
}
function presencePeers(){
  return (window.PaperProjectPresence?.readPeers(session) || []).filter(peer=>typeof peer.user?.name==='string').map(peer=>({...peer,user:{...peer.user,name:peer.user.name.slice(0,120),color:presenceColor(peer.user.color)}}))
}
function viewingCurrentResponse(peer){
  if(peer.self)return false
  const workspace=peer.workspace
  if(workspace?.surface)return workspace.surface==='rebuttal' && (!workspace.screen || workspace.screen==='reviews') && workspace.roundId===roundId && workspace.documentId===currentDocId
  return peer.rebuttal?.roundId===roundId && peer.rebuttal?.documentId===currentDocId
}
function responsePeerRange(peer,doc=documentFor()){
  const shared=doc && sharedTexts.get(doc.text_key || doc.id)
  return shared && peer.rebuttal?.anchorRelative && peer.rebuttal?.headRelative ? session.resolveRange(peer.rebuttal,shared) : null
}
function renderRemoteSelections(){
  if(!editor?.setRemoteSelections)return
  const cursors=[]
  if(reviewViewVisible && screen==='reviews' && !responsePreview){
    for(const peer of presencePeers()){
      if(!viewingCurrentResponse(peer) || !peer.rebuttal?.editing)continue
      const range=responsePeerRange(peer)
      if(range)cursors.push({id:String(peer.clientId),name:peer.user.name,color:peer.user.color,anchor:range[0],head:range[1]})
    }
  }
  editor.setRemoteSelections(cursors)
}

function peerLocation(peer){
  const workspace=peer.workspace || {},rebuttal=workspace.surface==='rebuttal' || (!workspace.surface && peer.rebuttal)
  if(rebuttal){
    const rid=workspace.roundId || peer.rebuttal?.roundId,did=workspace.documentId || peer.rebuttal?.documentId
    const r=state.rounds.find(r=>r.id===rid),doc=r?.documents.find(d=>d.id===did),view=workspace.screen || 'reviews'
    const label=view==='reviews'?(doc?.title || t('Response','답변')):({overview:t('Overview','개요'),evidence:t('Evidence & tasks','근거·작업'),submission:t('Submission','제출본')}[view] || t('Reviews','리뷰'))
    return {surface:'rebuttal',round:r,doc,screen:view,label:['Rebuttal',r?.title,label].filter(Boolean).join(' · '),available:Boolean(r && (view!=='reviews' || doc))}
  }
  const file=workspace.file || peer.cursor?.active_file
  return {surface:'paper',file,label:file?`Paper · ${file}`:t('Connected','접속 중'),available:typeof file==='string' && file.startsWith('paper/')}
}
async function followProjectPeer(peer){
  const location=peerLocation(peer)
  projectPresence?.close()
  if(location.surface==='paper'){
    const position={file:location.file,anchorRelative:peer.cursor?.anchor,headRelative:peer.cursor?.head}
    if(window.parent!==window && window.parent.PaperWorkspaceFocusLocation){await window.parent.PaperWorkspaceFocusLocation(position);return}
    try{sessionStorage.setItem(`paper-presence-location:${slug}`,JSON.stringify(position))}catch{}
    window.location.assign(`/p/${encodeURIComponent(slug)}?lang=${language}`)
    return
  }
  if(!location.available)return
  roundId=location.round.id;screen=location.screen;selectedConcern=null;sourceSelections=[];responseSelections=[];targetIds=null
  if(location.doc){currentDocId=location.doc.id;currentReviewerId=location.doc.reviewer_id || undefined}
  updateRoundURL(true);await bindTexts();renderAll()
  if(screen==='reviews' && editor && location.doc){
    const range=responsePeerRange(peer,location.doc)
    if(range)editor.setSelection(range[0],range[1],{scroll:true})
    editor.focus();syncReviewPresence()
  }
}
let projectPresence
function renderProjectPresence(){
  if(!window.PaperProjectPresence)return
  projectPresence ||= window.PaperProjectPresence.create({host:$('project-presence-root'),describe:peerLocation,onFollow:followProjectPeer,onError:error=>notice(error.message,true)})
  projectPresence.update({peers:presencePeers(),selfId:session?.provider?.awareness?.getLocalState()?.user?.id || profileActor?.id,language,connected:Boolean(session?.provider?.wsconnected)})
}
let responsePresence, responsePresenceHost
function renderReviewPresence(){
  renderProjectPresence();renderRemoteSelections()
  const container=$('review-collaborators')
  if(!container){responsePresence?.close();return}
  if(responsePresenceHost && container!==responsePresenceHost)container.replaceWith(responsePresenceHost)
  if(!responsePresence){
    responsePresenceHost=container
    responsePresence=window.PaperProjectPresence.create({host:container,scope:'response',describe:peerLocation,onFollow:followProjectPeer,onError:error=>notice(error.message,true)})
  }
  const allPeers=presencePeers()
  responsePresence.update({peers:allPeers.filter(viewingCurrentResponse),allPeers,selfId:profileActor?.id,language,connected:Boolean(session?.provider?.wsconnected)})
}

window.PaperRebuttalSetVisible=visible=>{reviewViewVisible=Boolean(visible);if(reviewViewVisible && answerLanguage==='ko' && screen==='reviews')void mountKorean();syncReviewPresence()}
document.addEventListener('visibilitychange',syncReviewPresence)
window.addEventListener('focus',scheduleReviewPresence)
window.addEventListener('blur',scheduleReviewPresence)
window.addEventListener('pagehide',()=>{reviewViewVisible=false;syncReviewPresence()})

let targetIds = null, commonMode = 'append', openreviewConnection = null
const sharedTexts = new Map(), localOrigin = {}
const comments = createRebuttalComments({getSession:()=>session,getDoc:()=>documentFor(),getReviewerId:()=>currentReviewerId,getRoundId:()=>roundId,getEditor:()=>editor,getActor:()=>profileActor,readOnly,translate:t,escape:esc,onNotice:notice,showSource:()=>setResponsePreview(false),onLayoutChange:()=>{editor?.requestMeasure?.();scheduleEdges();requestAnimationFrame(()=>comments.refreshMarkers())}})
const sessionBindings = createSessionBindings(window)
const responseRevisions = createResponseRevisionSync({
  enabled:()=>!readOnly && !sessionBindings.closed, isBusy:()=>busy,
  persist:persistResponseRevisions, onError:error=>notice(error.message,true)
})
const {pending:pendingStale, flush:flushResponseRevisions} = responseRevisions
sessionBindings.add(responseRevisions.cancel)
const round = () => state.rounds.find(item => item.id === roundId)
const connectionVisibilityKey = () => `paper-rebuttal-show-connections:${slug}:${roundId}`
function restoreConnectionVisibility() {
  if (!round() || connectionVisibilityRound === roundId) return
  connectionVisibilityRound = roundId
  const saved = window.PaperPreferenceStorage?.get(connectionVisibilityKey())
  showAllConnections = saved === 'true' || (saved !== 'false' && (round().mappings || []).some(mapping=>!mapping.superseded && mapping.decision!=='rejected'))
}
function setConnectionVisibility(value) {
  showAllConnections = Boolean(value)
  if (roundId) window.PaperPreferenceStorage?.set(connectionVisibilityKey(), String(showAllConnections))
}
const documentFor = () => round()?.documents.find(item => item.id === currentDocId)
const concernsForReviewer = id => (round()?.concerns || []).filter(item => !item.superseded && (item.reviewer_id === id || (item.source_spans || []).some(span => round().reviews.some(review => review.id === span.review_id && review.reviewer_id === id))))
function selectReviewer(id) {
  currentReviewerId = id
  currentDocId = round()?.documents.find(item => item.kind === 'reviewer' && item.reviewer_id === id)?.id
  selectedConcern = null; sourceSelections = []; responseSelections = []
}
const textsFor = (r=round()) => Object.fromEntries((r?.documents || []).map(doc => [doc.id, sharedTexts.get(doc.text_key || doc.id)?.toString() ?? doc.seed_text ?? '']))
const texts = () => textsFor()
const resolveResponseRange = span => { const doc=state.rounds.flatMap(r=>r.documents).find(doc=>doc.id===span.document_id);return doc?session?.resolveRange(span,sharedTexts.get(doc.text_key || doc.id)):null }
function verifiedResponseSpan(span,value){
  const verified=verifiedSpan(span,value,resolveResponseRange)
  if(verified)return verified
  if(typeof span.quote!=='string' || !span.quote)return null
  const start=value.indexOf(span.quote)
  if(start<0 || value.indexOf(span.quote,start+1)!==-1)return null
  return {...span,start,end:start+span.quote.length}
}
const badge = (label, tone = '') => `<span class="badge ${tone}">${esc(label)}</span>`
const viewActions = new Set(['open-review','open-document','select-concern','mapping-details','focus-span','view-job','view-submission','refresh','export','backup','response-history'])
const quietActions = new Set(['analysis','open-review','open-document','edit-concern','split-concern','mapping-details','focus-span','view-job','view-submission','refresh','backup','archive-export','glossary','comment-work','comment-evidence'])
const action = (name, label, id = '', cls = '', disabled = false) => `<button type="button" data-action="${name}" data-id="${esc(id)}" class="${cls || (quietActions.has(name) ? 'quiet' : '')}" ${disabled || readOnly && !viewActions.has(name) ? 'disabled' : ''}>${esc(label)}</button>`
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`
const field = (name, label, value = '', type = 'text', help = '') => `<label class="field">${esc(label)}${type === 'textarea' ? `<textarea name="${esc(name)}">${esc(value)}</textarea>` : `<input name="${esc(name)}" type="${type}" value="${esc(value)}">`}${help ? `<span class="form-help">${esc(help)}</span>` : ''}</label>`
const selectField = (name, label, values, value, property = false) => `<label class="field${property ? ' property-row' : ''}"><span>${esc(label)}</span><select name="${esc(name)}" ${property ? `data-property-picker data-property-label="${esc(label)}"` : ''}>${values.map(([id, text]) => option(id, text, id === value)).join('')}</select></label>`
const checkbox = (name, label, checked = false, { switchControl = false } = {}) => `<label class="field checkbox${switchControl ? ' switch-label' : ''}"><input type="checkbox" ${switchControl ? 'role="switch"' : ''} name="${esc(name)}" ${checked ? 'checked' : ''}>${esc(label)}</label>`
const statusText = value => ({ todo: t('To do', '할 일'), review: t('In review', '검토 중'), confirmed: t('Confirmed', '확인됨'), done: t('Done', '완료'), blocked: t('Blocked', '막힘'), addressed: t('Addressed', '답변됨'), partial: t('Partial', '부분 답변'), related: t('Related', '관련됨'), missing: t('Missing', '누락'), uncertain: t('Uncertain', '불확실'), proposed: t('Proposed', '제안됨'), rejected: t('Rejected', '거절됨'), stale: t('Outdated', '재확인 필요'), running: t('Running', '진행 중'), queued: t('Queued', '대기 중'), completed: t('Completed', '완료'), succeeded: t('Completed', '완료'), failed: t('Failed', '실패'), cancelled: t('Cancelled', '취소됨') }[value] || value || '')
const taskText = value => ({ analyze: t('Analyze reviews', '리뷰 분석'), translate: t('Translate reviews', '리뷰 번역'), map: t('Map responses', '답변 연결 분석'), connect: t('Review–response connections', '리뷰–답변 연결'), style: t('Check wording', '표현 점검'), consistency: t('Check consistency', '일관성 점검'), simulate: t('Simulate reviewer', '리뷰어 시뮬레이션'), rewrite: t('Rewrite selection', '선택 영역 재작성'), research_rules: t('Research official rules', '공식 규정 조사') }[value] || value)

function notice(message, error = false) {
  $('notice').replaceChildren()
  $('notice').className = `notice${error ? ' error' : ''}`
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', t('Dismiss', '닫기')); close.onclick = () => { $('notice').hidden = true }
  $('notice').append(close, document.createTextNode(message)); $('notice').hidden = false
}
let requestSequence = 0, adoptedSequence = 0
const responseSequences = new WeakMap()
async function request(path, data, method = 'POST', {signal} = {}) {
  const sequence = ++requestSequence
  const response = await fetch(`${base}${path}`, { method: data === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', credentials: 'same-origin', ...(signal ? {signal} : {}), ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
  let result
  try { result = await response.json() } catch { throw new Error(t('The server returned an unreadable response.', '서버 응답을 읽을 수 없습니다.')) }
  if (!response.ok) {
    if (response.status === 409) {
      await refresh(false,{sync:false})
      throw Object.assign(new Error(t('Another collaborator updated this round. Your form is preserved; review the latest state and save again.', '다른 공동 작업자가 라운드를 수정했습니다. 입력한 내용은 유지됩니다. 최신 상태를 확인한 후 다시 저장하세요.')),{status:409})
    }
    throw Object.assign(new Error(result.error?.message || result.error || result.detail || `${t('Request failed', '요청 실패')} (${response.status})`),{status:response.status})
  }
  if (result && typeof result === 'object') responseSequences.set(result, sequence)
  return result
}
function canAdopt(next) {
  if (next === state) return true
  if (!Array.isArray(next?.rounds) || !Number.isFinite(next.revision)) return false
  return next.revision > state.revision || (next.revision === state.revision && (responseSequences.get(next) ?? adoptedSequence) >= adoptedSequence)
}
function adopt(next, render = true) {
  if (sessionBindings.closed || !canAdopt(next)) return false
  if (next !== state) adoptedSequence = responseSequences.get(next) ?? adoptedSequence
  state = next
  markPendingResultsStale(pendingStale)
  if(pendingStale.size)updateFreshnessUI()
  if (!round()) roundId = state.rounds[0]?.id
  if (round()) {
    restoreConnectionVisibility()
    const reviewers = reviewerIds()
    if (!reviewers.includes(currentReviewerId)) currentReviewerId = reviewers[0]
    if (!round().documents.some(doc => doc.id === currentDocId)) currentDocId = round().documents.find(doc => doc.kind === 'reviewer' && doc.reviewer_id === currentReviewerId)?.id || (!currentReviewerId || !round().documents.some(doc=>doc.kind==='reviewer') ? round().documents[0]?.id : undefined)
    bindTexts()
    reconcileFreshness()
    updateRoundURL()
  }
  if (render) {renderAll();restoreNavigationContext()} else syncResponseCheck()
  return true
}
function restoreNavigationContext() {
  if (!sessionReady || !navigationContext || (screen==='reviews' && documentFor() && !editor)) return
  const saved=navigationContext;navigationContext=null
  requestAnimationFrame(()=>{if(editor&&saved.currentDocId===currentDocId&&saved.selection){const length=editor.getValue().length;editor.setSelection(Math.min(length,Math.max(0,saved.selection.start||0)),Math.min(length,Math.max(0,saved.selection.end||0)));if(editor.scrollDOM)editor.scrollDOM.scrollTop=saved.editorScroll||0}window.scrollTo(0,saved.scrollY||0)})
}
async function refresh(render = true, {sync=true} = {}) {
  let next
  do {
    if(sync && !busy)await flushResponseRevisions()
    next=await request('/state')
  } while(sync && !busy && !sessionBindings.closed && (pendingStale.size || responseRevisions.flushing))
  adopt(next, render)
  return next
}
async function mutate(path, data = {}, method = 'POST', {render = true} = {}) {
  if (readOnly && !path.endsWith('/exports')) throw new Error(t('This project is read only.', '읽기 전용 프로젝트입니다.'))
  if (busy) throw new Error(t('Please wait for the current save.', '현재 저장이 끝날 때까지 기다려 주세요.'))
  busy = true
  try {
    const result = await request(path, { ...data, expected_revision: state.revision }, method)
    adopt(result,render)
    return result
  } finally { busy = false }
}
async function updateRound(change, targetRoundId=roundId) {
  const initial = state.rounds.find(r=>r.id===targetRoundId)
  if (!initial) throw new Error(t('This round is no longer available. Your form is preserved.', '라운드를 더 이상 사용할 수 없습니다. 입력한 내용은 유지됩니다.'))
  const baseline = clone($('form-dialog').open && dialogRoundSnapshot?.id===targetRoundId ? dialogRoundSnapshot : initial)
  // Capture the user's edit once: retrying must not repeat generated IDs or appends.
  const edited = clone(baseline); change(edited)
  for(let attempt=0;attempt<3;attempt++) {
    const latest = state.rounds.find(r=>r.id===targetRoundId)
    if (!latest) throw new Error(t('This round is no longer available. Your form is preserved.', '라운드를 더 이상 사용할 수 없습니다. 입력한 내용은 유지됩니다.'))
    const merged = mergeRoundEdit(baseline, edited, latest)
    if (merged.conflicts.length) throw new Error(t('A field you edited was also changed by another collaborator. Your input is preserved. Copy your changes, close this form and reopen the latest item to review both versions before saving.', '수정한 항목을 다른 공동 작업자도 변경했습니다. 입력한 내용은 유지됩니다. 변경 내용을 복사한 뒤 이 창을 닫고 최신 항목을 다시 열어 두 내용을 검토해 주세요.'))
    try {
      return await mutate(`/rounds/${encodeURIComponent(latest.id)}`, { round: merged.round, texts: textsFor(merged.round) }, 'PUT')
    } catch(error) {
      // request() has already refreshed the latest state after a revision conflict.
      if(error.status!==409 || attempt===2)throw error
    }
  }
}
function updateRoundURL(record = false) {
  const url = new URL(location.href)
  if(roundId)url.searchParams.set('round',roundId);else url.searchParams.delete('round')
  history.replaceState(history.state,'',url)
  if(window.parent!==window)window.parent.PaperWorkspaceReviewLocation?.(window,url.href,record)
}
window.PaperRebuttalNavigateURL = async href => {
  const url=new URL(href,location.href)
  if(url.origin!==location.origin)return
  const nextRound=url.searchParams.get('round') || url.pathname.match(/\/rebuttal\/([^/]+)/)?.[1]
  const nextScreen=url.hash.slice(1)
  if(nextRound && nextRound!==roundId && state.rounds.some(r=>r.id===nextRound)){
    roundId=nextRound;currentDocId=null;currentReviewerId=null;selectedConcern=null;sourceSelections=[];responseSelections=[];targetIds=null
  }
  if(['overview','reviews','evidence','submission'].includes(nextScreen))screen=nextScreen
  const ownURL=new URL(location.href);ownURL.search=url.search;ownURL.searchParams.set('embedded','1');ownURL.hash=url.hash
  history.replaceState(history.state,'',ownURL)
  adopt(state)
  await textBinding
}

function reviewerIds() { return [...new Set([...(round()?.reviewers || []).map(item => typeof item === 'string' ? item : item.id), ...(round()?.reviews || []).map(item => item.reviewer_id)].filter(Boolean))] }
function reviewerName(id) { const item = round()?.reviewers.find(item => item.id === id); return item?.label || item?.name || item?.title || id || t('General', '전체') }
function bindTexts() {
  if (!sessionReady || sessionBindings.closed) return Promise.resolve()
  textBinding = textBinding.catch(()=>{}).then(async()=>{
    const documents=state.rounds.flatMap(r=>r.documents.map(doc=>({r,doc,key:doc.text_key || doc.id})))
    const seeds=documents.flatMap(({doc,key})=>[{key,initial:doc.seed_text || ''},...(typeof doc.korean_seed?.text==='string'?[{key:koreanKey(doc),initial:doc.korean_seed.text}]:[])])
    const missing=seeds.filter(({key})=>!session.mapFor('rebuttalResponses').has(key))
    const attach=()=>{if(sessionBindings.closed)return;for (const {r,doc,key} of documents) {
      restoreKoreanMetadata(doc)
      if (!readOnly && !session.mapFor('rebuttalResponses').has(key)) continue
      const shared=session.namespacedTextFor('rebuttalResponses',key,doc.seed_text || '',{readOnly})
      if (sharedTexts.get(key)===shared) continue
      sharedTexts.set(key,shared)
      scheduleResponseVersion(r.id,doc)
      sessionBindings.observe(shared,event=>{
        if(sharedTexts.get(key)!==shared)return
        if (documentFor()?.text_key===key || documentFor()?.id===key) if (editor && event.transaction.origin!==localOrigin) editor.setValue(shared.toString())
        scheduleResponseVersion(r.id,doc)
        markStale(doc.id);updateMechanical()
        if(documentFor()?.id===doc.id)comments.refreshAnchors()
        renderRemoteSelections()
        if(event.transaction.origin===localOrigin)scheduleReviewPresence()
        if (responsePreview && documentFor()?.id===doc.id) updateResponsePreview()
        if (answerLanguage==='ko' && documentFor()?.id===doc.id){renderKoreanStatus(doc);scheduleKoreanRefresh(doc)}
      })
      if ((documentFor()?.text_key || currentDocId)===key) {renderAll();restoreNavigationContext()}
    }}
    // Cached shared texts stay editable even when creating another response
    // needs a server connection that is currently unavailable.
    attach()
    if (sessionBindings.closed) return
    if (!readOnly && missing.length) await session.ensureNamespacedTexts('rebuttalResponses', missing)
    attach()
    textBindingError=null
  }).catch(error=>{
    if(sessionBindings.closed)return
    textBindingError=error.message
    if (screen==='reviews' && !sharedTexts.has(documentFor()?.text_key || currentDocId)) renderAll()
    notice(t('Could not prepare response editing: ','답변 편집 준비 실패: ')+error.message,true)
  })
  return textBinding
}
const responseVersionTimers = new Map()
const responseVersionSaves = new Map()
function responseVersionPath(rid, did) { return `/rounds/${encodeURIComponent(rid)}/documents/${encodeURIComponent(did)}/versions` }
function collaborationSynced() { return Boolean(sessionReady && !session?.offline && session?.provider?.synced) }
function saveResponseVersion(rid, doc, content, reason='auto') {
  if (readOnly || !collaborationSynced()) return Promise.reject(new Error(t('Connect collaboration before saving a version.', '버전을 저장하려면 공동편집 연결이 필요합니다.')))
  const key = `${rid}:${doc.id}`
  const previous = responseVersionSaves.get(key) || Promise.resolve()
  const pending = previous.catch(()=>{}).then(()=>request(responseVersionPath(rid,doc.id), {content,reason}))
  responseVersionSaves.set(key,pending)
  pending.finally(()=>{if(responseVersionSaves.get(key)===pending)responseVersionSaves.delete(key)}).catch(()=>{})
  return pending
}
function scheduleResponseVersion(rid,doc) {
  if(readOnly || sessionBindings.closed)return
  const key=`${rid}:${doc.id}`
  clearTimeout(responseVersionTimers.get(key))
  responseVersionTimers.set(key,setTimeout(()=>{
    responseVersionTimers.delete(key)
    const value=sharedTexts.get(doc.text_key || doc.id)?.toString()
    if(typeof value==='string' && collaborationSynced())saveResponseVersion(rid,doc,value).catch(error=>notice(t('Could not save response history: ','답변 버전 저장 실패: ')+error.message,true))
  },5000))
}
async function responseHistory() {
  const doc=documentFor(), rid=roundId
  if(!doc || !collaborationSynced())throw new Error(t('Wait for collaboration to connect.','공동편집 연결이 완료될 때까지 기다려 주세요.'))
  const current=sharedTexts.get(doc.text_key || doc.id)?.toString()
  if(typeof current!=='string')throw new Error(t('Response is unavailable.','답변을 불러올 수 없습니다.'))
  if(!readOnly)await saveResponseVersion(rid,doc,current)
  const result=await request(responseVersionPath(rid,doc.id))
  const versions=result.versions || []
  const available=versions.filter(item=>typeof item.content==='string')
  const label=item=>`${new Date(item.created_at).toLocaleString(language==='ko'?'ko-KR':'en-US')} · ${item.source==='paper'?t('Paper backup','Paper 백업'):item.reason==='pre-restore'?t('Before restore','복원 전'):t('Automatic','자동')} ${item.actor || ''}`
  const html=`<p class="form-help">${esc(doc.title)} · ${t('Select a version to compare with the current response.','버전을 선택해 현재 답변과 비교하세요.')}</p>${result.paper_unavailable?`<p class="form-help">${t('Paper backups are temporarily unavailable.','Paper 백업을 불러오지 못했습니다.')}</p>`:''}<label class="field">${t('Version','버전')}<select id="response-version-select">${available.map((item,index)=>option(String(index),label(item),index===0)).join('')}</select></label>${versions.length!==available.length?`<p class="form-help">${t('Some older Paper backups do not contain this response.','일부 오래된 Paper 백업에는 이 답변이 없습니다.')} (${versions.length-available.length})</p>`:''}<div class="response-version-compare"><section><h3>${t('Selected version','선택한 버전')}</h3><pre id="response-version-old" class="export-preview"></pre></section><section><h3>${t('Current response','현재 답변')}</h3><pre class="export-preview">${esc(current)}</pre></section></div>`
  showDialog(t('Response version history','답변 버전 이력'),html,available.length&&!readOnly?async()=>{
    const selected=available[Number($('response-version-select').value)]
    if(!selected || typeof selected.content!=='string')throw new Error(t('Select a version.','버전을 선택하세요.'))
    if(!collaborationSynced() || roundId!==rid || documentFor()?.id!==doc.id || sharedTexts.get(doc.text_key || doc.id)?.toString()!==current)throw new Error(t('The response changed. Reopen history and compare again.','답변이 변경됐습니다. 이력을 다시 열어 비교해 주세요.'))
    await saveResponseVersion(rid,doc,current,'pre-restore')
    const room=`paper-workspace:${location.host}:${slug}`
    const response=await fetch(`/collab-runtime/${encodeURIComponent(room)}?response-restore=1`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:doc.text_key || doc.id,expected:current,replacement:selected.content})})
    const result=await response.json()
    if(response.status===409)throw new Error(t('The response changed. Reopen history and compare again.','다른 작업자가 답변을 변경했습니다. 이력을 다시 열어 비교해 주세요.'))
    if(!response.ok)throw new Error(result.error || t('Restore failed.','복원에 실패했습니다.'))
    notice(t('Response restored.','답변을 복원했습니다.'))
  }:null,t('Restore selected version','선택한 버전 복원'))
  const select=$('response-version-select')
  const update=()=>{$('response-version-old').textContent=available[Number(select.value)]?.content ?? t('No saved response.','저장된 답변이 없습니다.')}
  select.addEventListener('change',update);update()
}
function markStale(documentId) {
  if(!readOnly){
    // Let the server see edits while a job is still running so it can
    // reject stale results before superseding existing connections.
    responseRevisions.queue(documentId, hasActiveAnalysis())
  }
  markPendingResultsStale(new Set([documentId]))
  updateFreshnessUI()
  for (const element of document.querySelectorAll(`[data-document-staleness="${CSS.escape(documentId)}"]`)) element.textContent = statusText('stale')
}
function markPendingResultsStale(ids) {
  for (const r of state.rounds) {
    const changed=r.documents.filter(doc=>ids.has(doc.id)).map(doc=>doc.id)
    if(!changed.length)continue
    for(const item of r.findings)if(ids.has(item.document_id))item.stale=true
    for(const item of r.mappings){
      const spans=item.response_spans || []
      if(spans.some(span=>ids.has(span.document_id)) ||
          (item.origin==='ai' || !spans.length) && changed.some(id=>!item.dependency_document_ids || item.dependency_document_ids.includes(id)))item.stale=true
    }
  }
}
function hasActiveAnalysis() {
  return state.jobs.some(job=>['queued','running'].includes(job.status))
}
async function persistResponseRevisions(ids) {
  for(const targetRound of state.rounds.filter(r=>r.documents.some(doc=>ids.has(doc.id)))){
    for(let attempt=0;attempt<3;attempt++){
      const r=state.rounds.find(r=>r.id===targetRound.id)
      if(!r || sessionBindings.closed)break
      const values=liveTextsFor(r,r.documents.filter(doc=>ids.has(doc.id)).map(doc=>doc.id))
      markPendingResultsStale(ids)
      // Publish against the latest round revision without using the dialog's
      // baseline or submitting any in-progress form fields.
      try {
        await mutate(`/rounds/${encodeURIComponent(r.id)}`,{round:r,texts:values},'PUT',{render:false})
        break
      } catch(error) {if(error.status!==409 || attempt===2)throw error}
    }
  }
}
function ensureEditor() {
  if (editor) return
  editor = window.PaperEditor.createEditor({ parent: $('response-editor'), language: 'markdown', readOnly, showLineNumbers: false, onChange(value) {
    const doc = documentFor(); if (!doc || !sessionReady || readOnly) return
    const shared = sharedTexts.get(doc.text_key || doc.id)
    if (shared) replaceSharedText(shared, value, localOrigin)
    markStale(doc.id); updateMechanical(); updateHighlights(); scheduleEdges(); scheduleReviewPresence()
  }, onSelection: () => {scheduleEdges();scheduleReviewPresence();comments.selectionChanged()}, onScroll: () => {scheduleEdges();comments.refreshMarkers()} })
  editor.contentDOM.setAttribute('aria-label', t('Response text', '답변 본문'))
}
// Keep Korean translations separate from the English response and any existing Korean drafts.
let answerLanguage = window.PaperPreferenceStorage?.get(answerLanguageKey)==='ko' ? 'ko' : 'en'
let pendingLanguagePosition = null, lastLanguagePosition = null
function koreanResponseRange(span,doc=documentFor()) {
  if(!doc || span.document_id!==doc.id)return null
  const original=sharedTexts.get(doc.text_key || doc.id)?.toString() || '', translated=koreanText(doc)?.toString() || '', meta=koreanMeta()?.get(doc.id)
  const verified=verifiedResponseSpan(span,original);if(!verified)return null
  return alignedResponseTranslation({...verified,anchorRelative:undefined,headRelative:undefined},original,translated,meta)
}
function koreanConnectionRanges({visibleOnly=true}={}) {
  const doc=documentFor();if(!doc || !round())return []
  return round().mappings.filter(map=>!map.superseded && map.decision!=='rejected' && (!visibleOnly || ((showAllConnections || selectedConcern===map.concern_id) && hasVisibleConnectionSource(map))))
    .flatMap(map=>(map.response_spans || []).filter(span=>span.document_id===doc.id).map(span=>({map,span,aligned:koreanResponseRange(span,doc)})))
}
// Text between table rows/cells is structural whitespace. An inline wrapper
// there creates anonymous table cells, shifting Korean highlighted columns.
function isTableStructureText(node) {
  return node.parentElement?.matches('table,thead,tbody,tfoot,tr,colgroup')
}
function wrapTextRange(root,start,end,map,excludeMath=false) {
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:node=>excludeMath && node.parentElement?.closest('mjx-container') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT})
  let position=0,node;const entries=[]
  while(node=walker.nextNode()){entries.push({node,start:position});position+=node.data.length}
  for(const entry of entries.reverse()){
    if(isTableStructureText(entry.node))continue
    const from=Math.max(0,start-entry.start),to=Math.min(entry.node.length,end-entry.start);if(from>=to)continue
    const range=document.createRange();range.setStart(entry.node,from);range.setEnd(entry.node,to)
    const mark=document.createElement('span');mark.className=`rebuttal-span connection-color-${connectionColorIndex(map.concern_id)}`
    mark.dataset.concernId=map.concern_id;mark.dataset.mappingId=map.id;mark.dataset.action='select-concern';mark.dataset.id=map.concern_id;mark.title=map.reason || ''
    mark.tabIndex=0;mark.setAttribute('role','button');range.surroundContents(mark)
  }
}
function renderKoreanConnections(host,value) {
  if(!host)return
  const ranges=answerLanguage==='ko' && value===(koreanText(documentFor())?.toString() || '')?koreanConnectionRanges():[]
  const signature=JSON.stringify([value,ranges.map(({map,aligned})=>[map.id,map.concern_id,map.reason,aligned,connectionColorIndex(map.concern_id)])])
  if(host._koreanSignature===signature)return
  host._koreanSignature=signature
  host.textContent=value
  for(const {map,aligned} of ranges)if(aligned)wrapTextRange(host,aligned.start,aligned.end,map)
}
function highlightKoreanPreview(preview) {
  for(const {map,aligned} of koreanConnectionRanges()){
    if(!aligned)continue
    if(/^\s*\|[^\n]+\|\s*$/.test(aligned.text)){
      const cells=aligned.text.trim().replace(/^\||\|$/g,'').split('|').map(cell=>{const temp=document.createElement('div');temp.innerHTML=window.PaperEditor.renderResponsePreview(cell.trim());return temp.textContent.trim()})
      const rows=[...preview.querySelectorAll('tr')].filter(row=>{const actual=[...row.querySelectorAll('th,td')].map(cell=>cell.textContent.trim());return actual.length===cells.length && actual.every((value,index)=>value===cells[index])})
      if(rows.length===1)for(const cell of rows[0].querySelectorAll('th,td'))wrapTextRange(cell,0,cell.textContent.length,map,true)
      continue
    }
    const fragment=document.createElement('div');fragment.innerHTML=window.PaperEditor.renderResponsePreview(aligned.text);fragment.querySelectorAll('mjx-container').forEach(node=>node.remove())
    const quote=fragment.textContent?.trim();if(!quote)continue
    const walker=document.createTreeWalker(preview,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement?.closest('mjx-container')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT})
    let content='',node;while(node=walker.nextNode())content+=node.data
    const start=content.indexOf(quote);if(start<0 || content.indexOf(quote,start+1)!==-1)continue
    wrapTextRange(preview,start,start+quote.length,map,true)
  }
}
function updateResponsePreview() {
  const preview = $('response-preview')
  if (!preview || !responsePreview) return
  const value=answerLanguage==='ko' ? koreanDisplayValue(documentFor()) : ($('response-editor')?.dataset.documentId===currentDocId && editor ? editor.getValue() : texts()[currentDocId] || '')
  if(answerLanguage==='ko'){
    const signature=JSON.stringify([value,$('response-korean')?.querySelector('[data-ko-text]')?._koreanSignature])
    if(preview._koreanSignature===signature)return
    preview._koreanSignature=signature
  }else preview._koreanSignature=null
  preview.innerHTML = window.PaperEditor.renderResponsePreview(value,{sourcePositions:true})
  preview._responseSource=value
  if(answerLanguage==='ko'){highlightKoreanPreview(preview);return}
  const mappings=(round()?.mappings || []).filter(map=>!map.superseded && map.decision!=='rejected' && (showAllConnections || selectedConcern===map.concern_id) && hasVisibleConnectionSource(map))
  for(const map of mappings)for(const span of map.response_spans || []){
    if(span.document_id!==currentDocId || !verifiedResponseSpan(span,value))continue
    const fragment=document.createElement('div');fragment.innerHTML=window.PaperEditor.renderResponsePreview(span.quote || '')
    const quote=fragment.textContent?.trim();if(!quote || fragment.querySelector('mjx-container'))continue
    const walker=document.createTreeWalker(preview,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement?.closest('mjx-container,.rebuttal-span')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT})
    const nodes=[];let text='',node;while(node=walker.nextNode()){nodes.push({node,start:text.length});text+=node.data}
    const start=text.indexOf(quote);if(start<0 || text.indexOf(quote,start+1)!==-1)continue
    const end=start+quote.length
    for(const entry of nodes.reverse()){
      if(isTableStructureText(entry.node))continue
      const from=Math.max(0,start-entry.start),to=Math.min(entry.node.length,end-entry.start)
      if(from>=to)continue
      const range=document.createRange();range.setStart(entry.node,from);range.setEnd(entry.node,to)
      const mark=document.createElement('span');mark.className=`rebuttal-span connection-color-${connectionColorIndex(map.concern_id)}`;mark.dataset.concernId=map.concern_id;mark.dataset.mappingId=map.id;mark.title=map.reason || '';range.surroundContents(mark)
    }
  }
}
let responseViewTransition=0
function setResponsePreview(value,{preservePosition=false}={}) {
  if(preservePosition){pendingLanguagePosition=null;lastLanguagePosition=null}
  const previous=responsePreview,docId=currentDocId,source=$('response-editor')?.dataset.documentId===currentDocId?editor?.getValue():undefined,transition=++responseViewTransition
  let position
  if(preservePosition && value!==previous && answerLanguage==='en' && editor && typeof source==='string'){
    if(previous){const preview=$('response-preview');if(preview?._responseSource===source)position=window.PaperEditor.previewSourcePosition(preview,source)}
    else {
      const bounds=editor.scrollDOM.getBoundingClientRect(),line=editor.dom.querySelector('.cm-line'),padding=line?parseFloat(getComputedStyle(line).paddingLeft):0
      const at=editor.view.posAtCoords({x:bounds.left+padding+3,y:Math.max(0,bounds.top)+12},false)
      if(at!==null){const coords=editor.coordsAt(at);position={position:at,offset:Math.max(0,(coords?.top || bounds.top)-bounds.top)}}
    }
  }
  if(preservePosition && !value && answerLanguage==='en' && source==='')position={position:0,offset:0}
  responsePreview = value
  const host = $('response-editor'), preview = $('response-preview')
  if (!host || !preview) return
  host.hidden = value || answerLanguage==='ko'; preview.hidden = !value
  const korean=$('response-korean');if(korean && answerLanguage==='ko'){korean.hidden=value;korean.classList.toggle('is-preview',value);const text=korean.querySelector('[data-ko-text]');if(text)text.hidden=value}
  for (const button of document.querySelectorAll('[data-response-view]')) button.setAttribute('aria-pressed', String(value))
  if (value) updateResponsePreview()
  else editor?.requestMeasure?.()
  if(position)requestAnimationFrame(()=>{
    if(transition!==responseViewTransition || currentDocId!==docId || answerLanguage!=='en' || responsePreview!==value || editor?.getValue()!==source)return
    if(value)window.PaperEditor.previewScrollToPosition(preview,position.position,position.offset,source)
    else {
      const margin=Math.min(position.offset,Math.max(0,editor.scrollDOM.clientHeight-40))
      editor.setSelection(position.position);editor.scrollTo(position.position,{y:'start',yMargin:margin});editor.focus()
      requestAnimationFrame(()=>{
        if(transition!==responseViewTransition || currentDocId!==docId || responsePreview || editor?.getValue()!==source)return
        const coords=editor.coordsAt(position.position),bounds=editor.scrollDOM.getBoundingClientRect()
        if(coords)editor.scrollDOM.scrollTop+=coords.top-bounds.top-margin
        scheduleEdges()
      })
    }
  })
  scheduleEdges();syncReviewPresence()
}
function responseReadingTexts(doc=documentFor()) {
  return {en:$('response-editor')?.dataset.documentId===doc?.id && editor ? editor.getValue() : (doc?koreanSource(doc):'').replace(/\r\n?/g,'\n'),ko:doc?koreanDisplayValue(doc):''}
}
function responseReadingHost() {
  return responsePreview ? $('response-preview') : answerLanguage==='en' ? editor?.scrollDOM : $('response-korean')
}
function captureLanguagePosition() {
  const host=responseReadingHost(),text=responseReadingTexts()[answerLanguage]
  if(!host || !text)return null
  let anchor
  if(responsePreview || answerLanguage==='ko')anchor=window.PaperEditor.previewSourcePosition(host,text,{fullyVisible:true})
  else {
    const bounds=host.getBoundingClientRect(),line=editor.dom.querySelector('.cm-line'),padding=line?parseFloat(getComputedStyle(line).paddingLeft):0
    const position=editor.view.posAtCoords({x:bounds.left+padding+3,y:Math.max(0,bounds.top)+12},false)
    if(position!==null){const coords=editor.coordsAt(position);anchor={position,offset:Math.max(0,(coords?.top || bounds.top)-bounds.top)}}
  }
  return anchor ? {...anchor,screenY:host.getBoundingClientRect().top+anchor.offset} : null
}
function readingTranslationMeta(doc,texts) {
  const progress=koreanProgress.get(doc.id),partial=progress?.progress?.translations?.find(item=>item.review_id===doc.id && item.field==='response')
  if(progress?.source.replace(/\r\n?/g,'\n')===texts.en && partial?.text===texts.ko)return {source:progress.source,translation:partial.text,segments:partial.segments || []}
  return koreanMeta()?.get(doc.id)
}
function restoreLanguagePosition() {
  const pending=pendingLanguagePosition,doc=documentFor(),host=responseReadingHost()
  if(!pending || pending.scheduled)return
  if(doc?.id!==pending.docId || answerLanguage!==pending.to || responsePreview!==pending.preview){pendingLanguagePosition=null;return}
  const texts=responseReadingTexts(doc)
  if(texts.en!==pending.english){pendingLanguagePosition=null;return}
  if(!host?.isConnected || !host.clientHeight || !texts[pending.to])return
  const translated=translatedReadingPosition(pending.position,texts.en,texts.ko,readingTranslationMeta(doc,texts),pending.from)
  const rememberedPosition=pending.remembered?.texts.ko===texts.ko ? pending.remembered.positions[pending.to] : null
  let position=rememberedPosition ?? translated
  if(position==null){
    if(pending.to==='ko' && koreanTranslating.has(doc.id))return
    position=Math.round(pending.position/Math.max(1,pending.fromText.length)*texts[pending.to].length)
  }
  position=Math.max(0,Math.min(position,texts[pending.to].length))
  pending.scheduled=true
  requestAnimationFrame(()=>{
    if(pendingLanguagePosition!==pending)return
    if(documentFor()?.id!==pending.docId || answerLanguage!==pending.to || responsePreview!==pending.preview || responseReadingTexts(doc).en!==pending.english){pendingLanguagePosition=null;return}
    // A progressing translation may have replaced the DOM while we waited.
    if(responseReadingTexts(doc)[pending.to]!==texts[pending.to]){pending.scheduled=false;restoreLanguagePosition();return}
    window.scrollTo(window.scrollX,pending.pageY)
    const offset=Math.max(0,pending.screenY-host.getBoundingClientRect().top)
    if(responsePreview || answerLanguage==='ko'){
      const restored=window.PaperEditor.previewScrollToPosition(host,position,offset,texts[pending.to])
      if(restored===false){pending.scheduled=false;return}
    }
    else editor.scrollTo(position,{y:'start',yMargin:Math.min(offset,Math.max(0,host.clientHeight-40))})
    requestAnimationFrame(()=>{
      if(pendingLanguagePosition!==pending)return
      if(documentFor()?.id!==pending.docId || answerLanguage!==pending.to || responsePreview!==pending.preview || responseReadingTexts(doc)[pending.to]!==texts[pending.to]){pendingLanguagePosition=null;return}
      if(!responsePreview && answerLanguage==='en'){
        const coords=editor.coordsAt(position)
        if(coords)host.scrollTop+=coords.top-host.getBoundingClientRect().top-offset
      }
      lastLanguagePosition={docId:doc.id,preview:responsePreview,texts,positions:{[pending.from]:pending.position,[pending.to]:position},screenY:pending.screenY,language:pending.to,scrollTop:host.scrollTop,pageY:window.scrollY}
      pendingLanguagePosition=null;scheduleEdges()
    })
  })
}
function changeAnswerLanguage(next) {
  if(!['en','ko'].includes(next) || next===answerLanguage)return
  const doc=documentFor(),texts=responseReadingTexts(doc),host=responseReadingHost(),pageY=window.scrollY,previous=pendingLanguagePosition
  const returning=previous?.docId===doc?.id && previous.from===next && previous.english===texts.en && previous.preview===responsePreview
  const from=returning?next:answerLanguage,anchor=returning?{position:previous.position,screenY:previous.screenY}:captureLanguagePosition()
  const remembered=returning ? {texts,positions:{[next]:previous.position}} : lastLanguagePosition?.docId===doc?.id && lastLanguagePosition.preview===responsePreview && lastLanguagePosition.language===from && lastLanguagePosition.texts.en===texts.en && lastLanguagePosition.texts.ko===texts.ko && Math.abs(lastLanguagePosition.scrollTop-(host?.scrollTop || 0))<1 && Math.abs(lastLanguagePosition.pageY-pageY)<1 ? lastLanguagePosition : null
  pendingLanguagePosition=null
  answerLanguage=next
  window.PaperPreferenceStorage?.set(answerLanguageKey,next)
  for(const button of document.querySelectorAll('[data-answer-language]'))button.setAttribute('aria-pressed',String(button.dataset.answerLanguage===answerLanguage))
  const footer=document.querySelector('.response-panel .editor-footer');if(footer)footer.hidden=answerLanguage==='ko'
  const mounting=mountKorean()
  setResponsePreview(responsePreview)
  if(doc && anchor)pendingLanguagePosition={docId:doc.id,from,to:next,english:texts.en,fromText:texts[from],position:remembered?.positions[from] ?? anchor.position,screenY:remembered?.screenY ?? anchor.screenY,pageY:returning?previous.pageY:pageY,preview:responsePreview,remembered}
  void mounting.then(restoreLanguagePosition)
  restoreLanguagePosition();scheduleEdges();syncReviewPresence()
}
for(const type of ['wheel','touchstart','pointerdown'])document.addEventListener(type,event=>{
  if(event.target.closest?.('#response-editor,#response-preview,#response-korean'))pendingLanguagePosition=null
},{passive:true,capture:true})
document.addEventListener('keydown',event=>{
  if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key) && event.target.closest?.('#response-editor,#response-preview,#response-korean'))pendingLanguagePosition=null
},{capture:true})
const responseCheckRunning = jobs => (jobs || []).some(job => job.round_id === roundId && ['connect','map','analyze'].includes(job.task) && ['queued','running'].includes(job.status))
function syncResponseCheck() {
  const locked = checkSubmitting || responseCheckRunning(state.jobs)
  const indicator = $('response-check-progress')
  if (indicator) indicator.hidden = !locked
  const activeJob=(state.jobs || []).find(job=>job.round_id===roundId && ['connect','map','analyze'].includes(job.task) && ['queued','running'].includes(job.status))
  const cancel=indicator?.querySelector('.response-check-cancel')
  if(cancel){cancel.hidden=!activeJob;cancel.disabled=readOnly || !sessionReady;if(activeJob)cancel.dataset.id=activeJob.id}
  const panel=document.querySelector('.response-panel')
  panel?.classList.toggle('is-checking',locked)
  panel?.setAttribute('aria-busy',String(locked))
  for(const id of ['response-editor','response-preview']){const content=$(id);if(content)content.inert=locked}
  if (editor && $('response-editor')?.contains(editor.dom)) {
    const effectiveReadOnly = readOnly || locked
    if (editor.view.state.readOnly !== effectiveReadOnly) editor.setReadOnly(effectiveReadOnly)
    editor.contentDOM.setAttribute('aria-busy', String(locked))
  }
}
function detachEditor() { if (editor) editor.dom.remove() }
function restoreControlFocus(previous) {
  if (!previous || !previous.matches('button,input,textarea,select,summary,[role="button"]')) return
  const selection = previous instanceof HTMLTextAreaElement ? [previous.selectionStart, previous.selectionEnd, previous.selectionDirection, previous.scrollTop] : null
  if(previous.isConnected){if(document.activeElement!==previous && previous.getClientRects().length)previous.focus({preventScroll:true});return}
  let selector = previous.id ? `#${CSS.escape(previous.id)}` : ''
  if (!selector) {
    const attribute = ['data-action','data-screen','data-review-language'].find(name => previous.hasAttribute(name))
    if (attribute) selector = `[${attribute}="${CSS.escape(previous.getAttribute(attribute))}"]${previous.hasAttribute('data-id') ? `[data-id="${CSS.escape(previous.dataset.id)}"]` : ''}`
  }
  if (!selector && previous.matches('summary')) {
    const details=previous.parentElement
    if(details?.id)selector=`#${CSS.escape(details.id)} > summary`
    else if(details?.matches('.sidebar-advanced'))selector='.sidebar-advanced > summary'
  }
  const replacement = selector ? document.querySelector(selector) : null
  if (replacement?.getClientRects().length) { replacement.focus({preventScroll:true}); if (selection && replacement instanceof HTMLTextAreaElement) { replacement.setSelectionRange(...selection.slice(0,3)); replacement.scrollTop=selection[3] } }
}
function captureReviewScroll() {
  const host=$('response-editor')
  if(!host || !editor?.dom?.isConnected || !host.contains(editor.dom))return null
  return {docId:host.dataset.documentId,editorTop:editor.scrollDOM.scrollTop,editorLeft:editor.scrollDOM.scrollLeft,reviewTop:$('review-content')?.scrollTop || 0,previewTop:$('response-preview')?.scrollTop || 0,koreanTop:$('response-korean')?.scrollTop || 0}
}
function restoreReviewScroll(saved) {
  if(!saved || saved.docId!==currentDocId || screen!=='reviews')return
  if(editor?.scrollDOM){editor.scrollDOM.scrollTop=saved.editorTop;editor.scrollDOM.scrollLeft=saved.editorLeft}
  if($('review-content'))$('review-content').scrollTop=saved.reviewTop
  if($('response-preview'))$('response-preview').scrollTop=saved.previewTop
  if($('response-korean'))$('response-korean').scrollTop=saved.koreanTop
  scheduleEdges()
}
function toggleSidebarAdvanced(menu) {
  const expanded=menu.dataset.expanded!=='true'
  const from=menu.getBoundingClientRect().height
  const previous=sidebarAdvancedAnimation;sidebarAdvancedAnimation=null;previous?.cancel()
  sidebarAdvancedOpen=expanded
  menu.dataset.expanded=String(expanded)
  const summary=menu.querySelector(':scope > summary')
  summary.setAttribute('aria-expanded',String(expanded))
  for(const button of menu.querySelectorAll(':scope > button'))button.inert=!expanded
  if(matchMedia('(prefers-reduced-motion: reduce)').matches || !menu.getClientRects().length){
    menu.open=expanded;menu.style.overflow='';return
  }
  // Keep native details open until the closing animation has completed.
  menu.open=true
  const to=expanded?menu.getBoundingClientRect().height:summary.getBoundingClientRect().height
  menu.style.overflow='hidden'
  const animation=menu.animate([{height:`${from}px`},{height:`${to}px`}],{duration:220,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'})
  animation.id='rebuttal-sidebar-advanced-motion'
  sidebarAdvancedAnimation=animation
  animation.finished.then(()=>{
    if(sidebarAdvancedAnimation!==animation || !menu.isConnected)return
    sidebarAdvancedAnimation=null;menu.open=expanded;menu.style.overflow='';animation.cancel()
  }).catch(()=>{})
}
$('screen-nav').addEventListener('click',event=>{
  const summary=event.target.closest('.sidebar-advanced > summary')
  if(!summary || event.button!==0)return
  event.preventDefault();toggleSidebarAdvanced(summary.parentElement)
})
function renderAll() {
  const savedScroll=captureReviewScroll()
  const focusedControl = document.activeElement
  const focusedEditor = editor?.focusWithin()
  const previousAdvanced=document.querySelector('.sidebar-advanced')
  if(previousAdvanced)sidebarAdvancedOpen=(previousAdvanced.dataset.expanded ?? String(previousAdvanced.open))==='true'
  const previousAdvancedAnimation=sidebarAdvancedAnimation;sidebarAdvancedAnimation=null;previousAdvancedAnimation?.cancel()
  detachEditor()
  renderSyncStatus()
  applyReviewSidebar(); $('project-label').textContent = slug; $('review-sidebar-title').textContent=t('Reviews & responses','리뷰·답변')
  $('review-view-title').textContent = ({reviews:t('Reviews & responses','리뷰와 답변'),overview:t('Overview & rules','개요와 규정'),evidence:t('Evidence & tasks','근거와 작업'),submission:t('Submission','제출')})[screen]
  $('main').dataset.reviewView = screen
  $('new-round').textContent = t('＋ New round', '＋ 새 라운드')
  $('new-round').disabled = readOnly || state.enabled===false
  $('round-label').textContent = t('Round', '라운드')
  $('round-select').dataset.propertyLabel = t('Round', '라운드')
  updateWorkspaceNavigation()
  $('round-select').innerHTML = state.rounds.map(r => option(r.id, r.title, r.id === roundId)).join('')
  renderReviewerNav()
  const screenButton = (id, label) => `<button type="button" data-screen="${id}" aria-label="${label}" title="${label}" ${screen === id ? 'aria-current="page"' : ''}><span>${label}</span></button>`
  const sidebarExpanded=sidebarAdvancedOpen || ['overview','evidence','submission'].includes(screen)
  $('screen-nav').innerHTML = `<details class="sidebar-advanced" data-expanded="${sidebarExpanded}" ${sidebarExpanded?'open':''}><summary aria-expanded="${sidebarExpanded}"><svg class="sidebar-advanced-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg><span>${t('Advanced','고급')}</span></summary>${screenButton('submission',t('Submission','제출'))}${screenButton('overview',t('Overview & rules','개요와 규정'))}${screenButton('evidence',t('Evidence & tasks','근거와 작업'))}</details>`
  const sidebarMenu=document.querySelector('.sidebar-advanced')
  sidebarMenu.addEventListener('toggle',()=>{
    if(!sidebarMenu.isConnected || sidebarAdvancedAnimation?.effect?.target===sidebarMenu)return
    sidebarAdvancedOpen=sidebarMenu.open;sidebarMenu.dataset.expanded=String(sidebarMenu.open)
    sidebarMenu.querySelector('summary').setAttribute('aria-expanded',String(sidebarMenu.open))
    for(const button of sidebarMenu.querySelectorAll(':scope > button'))button.inert=!sidebarMenu.open
  })
  if (state.enabled === false) { $('main').innerHTML = `<div class="card empty"><h2>${t('Rebuttal is unavailable', 'Rebuttal을 사용할 수 없습니다')}</h2><p>${t('This workspace has not enabled rebuttal authoring.', '이 작업공간에 Rebuttal 작성 기능이 활성화되지 않았습니다.')}</p></div>`; return }
  if (!round()) { $('main').innerHTML = `<div class="card empty"><p class="eyebrow">REBUTTAL WORKSPACE</p><h2>${t('A thoughtful response starts here', '설득력 있는 답변을 시작하세요')}</h2><p>${t('Create a round to import reviews, connect concerns and prepare your submission.', '라운드를 만들고 리뷰를 가져와 우려 사항과 답변을 연결하고 제출본을 준비하세요.')}</p>${action('new-round', t('Create your first round', '첫 라운드 만들기'), '', 'primary')}</div>`; return }
  if (screen === 'overview') renderOverview()
  if (screen === 'reviews') renderReviews()
  if (screen === 'evidence') renderEvidence()
  if (screen === 'submission') renderSubmission()
  if (focusedEditor && screen === 'reviews') editor?.focus()
  else restoreControlFocus(focusedControl)
  restoreReviewScroll(savedScroll)
  syncReviewPresence()
}
function reviewerScores(id) {
  const reviews = (round()?.reviews || []).filter(review => review.reviewer_id === id)
  const values = (names) => {
    const found = new Set()
    for (const review of reviews) for (const [key, value] of Object.entries(review.fields || {})) {
      if (!names.includes(key.toLowerCase().trim().replace(/[ _-]+/g, ' '))) continue
      const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)(?=\s*(?:$|[:.)\-/\n]))/)
      if (match) found.add(match[1])
    }
    return found.size === 1 ? [...found][0] : null
  }
  return {rating: values(['rating', 'overall rating', 'overall score', 'recommendation']), confidence: values(['confidence', 'reviewer confidence'])}
}
const reviewerMateColors = ['red', 'blue', 'yellow', 'green', 'violet', 'orange', 'pink', 'turquoise', 'indigo', 'mint']
const reviewerMateAssets = reviewerMateColors.map(color => `/assets/reviewer-mates/${color === 'mint' ? 'mint-v2' : color}.png`)
function reviewerMates(ids) {
  const shared = session?.mapFor('rebuttalReviewerMates')
  const result = new Map(), used = new Set(), pending = []
  for (const id of ids) {
    const value = shared?.get(id)
    if (Number.isInteger(value) && value >= 0 && value < reviewerMateAssets.length) { result.set(id, value); used.add(value) }
  }
  for (const id of [...ids].sort()) {
    if (result.has(id)) continue
    let hash = 2166136261
    for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0
    const start = hash % reviewerMateAssets.length
    let value = start
    for (let offset = 0; offset < reviewerMateAssets.length; offset++) {
      const candidate = (start + offset) % reviewerMateAssets.length
      if (!used.has(candidate)) { value = candidate; break }
    }
    result.set(id, value); used.add(value); pending.push([id, value])
  }
  if (sessionReady && !readOnly && shared && pending.length) session.document.transact(() => {
    for (const [id, value] of pending) if (!shared.has(id)) shared.set(id, value)
  }, localOrigin)
  return result
}
function revealReviewerSelection() {
  if(innerWidth>=768)return
  const nav=$('reviewer-nav'),active=nav.querySelector('[data-action="open-document"][aria-current="page"]') || nav.querySelector('[data-action="open-review"][aria-current="page"]')
  if(!active)return
  const viewport=nav.getBoundingClientRect(),item=active.getBoundingClientRect()
  if(item.left<viewport.left)nav.scrollLeft+=item.left-viewport.left
  else if(item.right>viewport.right)nav.scrollLeft+=item.right-viewport.right
}
window.addEventListener('resize',revealReviewerSelection)
document.fonts.ready.then(revealReviewerSelection)
function renderReviewerNav() {
  const ids = reviewerIds(), mates = reviewerMates(ids)
  $('reviewer-nav').innerHTML = `<p class="reviewer-nav-label">${t('Reviewers','리뷰어')}</p>` + ids.map(id => {
    const {rating,confidence} = reviewerScores(id)
    const score = `${rating ?? '—'}/${confidence ?? '—'}`
    const description = `${t('Rating','점수')}: ${rating ?? t('Unavailable','정보 없음')}, ${t('Confidence','확신도')}: ${confidence ?? t('Unavailable','정보 없음')}`
    const collapsed = document.body.classList.contains('is-sidebar-collapsed')
    const opensReview = collapsed && (screen!=='reviews' || currentReviewerId!==id)
    const changeLabel = `${opensReview?t('Open review for','리뷰 열기:'):t('Change character for','캐릭터 변경:')} ${reviewerName(id)}`
    return `<div class="reviewer-nav-row"><button type="button" class="reviewer-mate-button" data-action="reviewer-mate-click" data-id="${esc(id)}" aria-label="${esc(changeLabel)}" title="${esc(changeLabel)}" ${!opensReview && (readOnly || !sessionReady)?'disabled':''}><img class="reviewer-mate" src="${reviewerMateAssets[mates.get(id)]}" alt="" aria-hidden="true"></button><button type="button" class="reviewer-nav-item" data-action="open-review" data-id="${esc(id)}" title="${esc(reviewerName(id))} · ${esc(description)}" ${screen==='reviews' && currentReviewerId===id?'aria-current="page"':''}><span class="reviewer-nav-copy"><strong>${esc(reviewerName(id))}</strong></span><span class="reviewer-progress" aria-label="${esc(description)}">${esc(score)}</span></button></div>`
  }).join('') + (round()?.documents || []).filter(doc => doc.kind !== 'reviewer').map(doc => `<button type="button" data-action="open-document" data-id="${esc(doc.id)}" ${screen==='reviews' && currentDocId===doc.id?'aria-current="page"':''}><span class="reviewer-initial" aria-hidden="true">↗</span><span class="reviewer-nav-copy"><strong>${esc(doc.title)}</strong></span></button>`).join('')
  syncReviewerSidebarControls()
  revealReviewerSelection()
}
function syncReviewerSidebarControls(){
  const collapsed=document.body.classList.contains('is-sidebar-collapsed')
  for(const button of document.querySelectorAll('#reviewer-nav .reviewer-mate-button')){
    const id=button.dataset.id, opensReview=collapsed && (screen!=='reviews' || currentReviewerId!==id)
    const label=`${opensReview?t('Open review for','리뷰 열기:'):t('Change character for','캐릭터 변경:')} ${reviewerName(id)}`
    button.setAttribute('aria-label',label);button.title=label;button.disabled=!opensReview && (readOnly || !sessionReady)
    const item=button.parentElement.querySelector('.reviewer-nav-item');if(item)item.inert=collapsed
  }
}
function changeReviewerMate(id) {
  if (!sessionReady || readOnly || !reviewerIds().includes(id)) throw new Error(t('The character cannot be changed yet.','아직 캐릭터를 변경할 수 없습니다.'))
  const selected = reviewerMates(reviewerIds()).get(id)
  const labels = [['Red','빨강'],['Blue','파랑'],['Yellow','노랑'],['Green','초록'],['Violet','보라'],['Orange','주황'],['Pink','분홍'],['Turquoise','청록'],['Indigo','남색'],['Mint','민트']]
  const choices = reviewerMateAssets.map((src,index)=>`<label class="mate-choice"><input type="radio" name="mate" value="${index}" ${index===selected?'checked':''}><img src="${src}" alt=""><span>${t(...labels[index])}</span></label>`).join('')
  showDialog(t('Choose reviewer character','리뷰어 캐릭터 선택'),`<p class="muted small">${esc(reviewerName(id))}</p><fieldset class="mate-picker"><legend class="sr-only">${t('Character','캐릭터')}</legend>${choices}</fieldset>`,data=>{
    const value=Number(data.get('mate'))
    if (!data.has('mate') || !Number.isInteger(value) || value<0 || value>=reviewerMateAssets.length) throw new Error(t('Choose a character.','캐릭터를 선택하세요.'))
    session.mapFor('rebuttalReviewerMates').set(id,value)
  })
}
function jobsHTML() {
  const jobs = (state.jobs || []).filter(job => !job.round_id || job.round_id === roundId)
  if (!jobs.length) return `<p class="muted small">${t('AI runs only when you request an action. Edits never start a run.', 'AI는 작업 버튼을 눌렀을 때만 실행합니다. 편집만으로 실행되지 않습니다.')}</p>`
  return jobs.slice().reverse().map(job => `<div class="job-row"><div><strong>${esc(taskText(job.task))}</strong> ${badge(statusText(job.status), job.status === 'failed' ? 'warn' : '')}<div class="small muted">${esc(job.stage || '')} ${esc(job.model || job.model_version || '')}${job.failed_stage ? ` · ${t('Failed at','실패 단계')}: ${esc(job.failed_stage)}` : ''}${job.error_code ? ` · ${t('Code','오류 코드')}: ${esc(job.error_code)}` : ''}</div>${job.error ? `<p class="error small">${esc(typeof job.error === 'string' ? job.error : job.error.message)}</p>` : ''}<div class="small muted">${esc(job.result?.summary || '')}</div>${['queued', 'running'].includes(job.status) ? '<div class="progress"><span></span></div>' : ''}</div><div class="actions">${['queued', 'running'].includes(job.status) ? action('cancel-job', t('Cancel', '취소'), job.id) : ['failed', 'cancelled'].includes(job.status) ? action('retry-job', t('Retry', '재시도'), job.id) : ''}${job.result?.replacement ? action('review-rewrite', t('Review rewrite', '재작성 검토'), job.id) : ''}${job.result?.simulated_questions?.length ? action('view-job', t('View questions', '질문 보기'), job.id) : ''}${job.result?.rules_candidates?.length ? action('review-rule-candidates',t('Review rule candidates','규정 후보 검토'),job.id):''}</div></div>`).join('')
}
function renderOverview() {
  const r = round(), confirmed = r.concerns.filter(concern => !concern.superseded && r.mappings.some(map => map.concern_id === concern.id && map.decision === 'confirmed' && map.coverage === 'addressed' && !map.stale)).length
  const active = r.rules.find(rule => rule.id === r.active_rules_id)
  $('main').innerHTML = `<div class="stats">${[[r.reviews.length,t('Reviews', '리뷰')],[`${confirmed} / ${r.concerns.filter(concern=>!concern.superseded).length}`,t('Concerns addressed', '답변 확인한 우려')],[r.documents.length,t('Response documents', '답변 문서')],[r.work_items.filter(item => !['done','confirmed'].includes(item.status)).length,t('Open work items', '남은 작업')]].map(([n,label])=>`<div class="stat"><strong>${n}</strong><span>${label}</span></div>`).join('')}</div><div class="grid"><section class="card"><div class="card-header"><h2>${t('Review collection','리뷰 모음')}</h2>${action('import',t('Import reviews','리뷰 가져오기'),'','primary')}</div><p class="muted">${t('Paste text or import JSON, PDF and OpenReview. Review the extraction before adding it.','텍스트, JSON, PDF 또는 OpenReview에서 가져오고 추출 내용을 확인한 뒤 추가하세요.')}</p>${r.reviews.length ? reviewerIds().map(id => `<div class="item-row"><div><strong>${esc(reviewerName(id))}</strong><div class="small muted">${r.reviews.filter(review => review.reviewer_id === id).length} ${t('review(s)','리뷰')}</div></div>${action('open-review', t('Open','열기'),id)}</div>`).join('') : `<div class="empty">${t('No reviews imported yet.','아직 가져온 리뷰가 없습니다.')}</div>`}<div class="actions">${action('glossary',t('Translation glossary','번역 용어집'))}${action('openreview-session',openreviewConnection?t('OpenReview connection','OpenReview 연결'):t('Connect OpenReview','OpenReview 연결'))}</div></section><section class="card"><div class="card-header"><h2>${t('Response documents','답변 문서')}</h2>${action('new-document',t('＋ Add','＋ 추가'))}</div>${r.documents.length ? r.documents.map(doc => `<div class="item-row"><div><strong>${esc(doc.title)}</strong><div class="small muted">${doc.kind === 'common' ? t('Common response','공통 답변') : doc.kind === 'unified' ? t('Unified response','통합 답변') : esc(reviewerName(doc.reviewer_id))}</div></div>${action('open-document',t('Write','작성'),doc.id)}</div>`).join('') : `<p class="empty">${t('Create reviewer responses or an optional common response.','리뷰어별 답변 또는 선택적인 공통 답변을 만드세요.')}</p>`}</section><section class="card full"><div class="card-header"><h2>${t('Venue rules','학회 규정')}</h2><div class="actions">${active ? badge(`${active.venue || ''} ${active.year || ''}`, 'good') : badge(t('No active limits','적용된 제한 없음'))}${action('rules',t('Set rules','규정 작성'))}${action('analysis',taskText('research_rules'),'research_rules')}</div></div><p class="muted small">${t('Drafts require explicit application. Counts update locally as you type. No default length limit is assumed.','초안은 직접 적용해야 합니다. 분량은 입력 즉시 계산하며 기본 분량 제한은 설정하지 않습니다.')}</p><div id="mechanical-checks"></div>${renderRuleDrafts()}</section><section class="card full"><div class="card-header"><h2>${t('Analysis activity','분석 작업')}</h2><div class="actions">${action('archive-export',t('Archive export','보관용 내보내기'))}${action('backup',t('Download backup','백업 다운로드'))}${action('backup-restore',t('Restore backup','백업 복원'))}${action('refresh',t('Refresh','새로고침'))}</div></div>${jobsHTML()}</section></div>`
  updateMechanical()
}
function renderRuleDrafts() {
  const r = round(), active = r.rules.find(rule => rule.id === r.active_rules_id)
  return r.rules.filter(rule => rule.id !== r.active_rules_id).map(rule => `<details class="rule-draft"><summary>${esc(`${rule.venue || t('Rules draft','규정 초안')} ${rule.year || ''}`)} ${badge(t('Draft','초안'))}</summary><div class="rule-diff"><div><h3>${t('Currently applied','현재 적용')}</h3><pre>${esc(JSON.stringify(active || {}, null, 2))}</pre></div><div><h3>${t('Proposed rules','제안 규정')}</h3><pre>${esc(JSON.stringify(rule, null, 2))}</pre></div></div>${ruleSources(rule)}${action('apply-rules',t('Apply this version','이 버전 적용'),rule.id,'primary')}</details>`).join('')
}
function ruleSources(rule) { return `<ul class="source-list">${(rule.sources || []).map(source => `<li>${source.url && /^https?:\/\//.test(source.url) ? `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title || source.url)}</a>` : esc(source.title || '')} ${badge(source.status || 'unverified')}<div>${esc(source.excerpt || '')}</div><div class="muted">${esc(source.checked_at || '')}</div></li>`).join('')}</ul>` }
function connectionColorIndex(concernId) {
  const ids = (round()?.concerns || []).filter(concern=>!concern.superseded).map(concern=>concern.id).sort()
  return Math.max(0,ids.indexOf(concernId)) % 10
}
function alignedTranslation(review,field,quote){
  const original=review?.fields?.[field] || '', translated=review?.translations?.[field] || '', alignment=review?.translation_alignments?.[field]
  if(!quote || !translated || alignment?.source!==original || original.indexOf(quote)<0 || original.indexOf(quote)!==original.lastIndexOf(quote))return null
  const pairs=(alignment.segments || []).filter(pair=>pair.source?.includes(quote) && original.indexOf(pair.source)===original.lastIndexOf(pair.source) && pair.text && translated.indexOf(pair.text)>=0 && translated.indexOf(pair.text)===translated.lastIndexOf(pair.text))
  if(pairs.length!==1)return null
  const start=translated.indexOf(pairs[0].text);return {start,end:start+pairs[0].text.length,text:pairs[0].text}
}
function reviewFieldHTML(review, fieldName, original) {
  const value = koreanReview ? review.translations?.[fieldName] || original : original
  // Prefer connections that still point to the current response before resolving
  // overlaps. Otherwise an obsolete manual link can hide a newer valid one.
  const doc=documentFor(), response=doc ? sharedTexts.get(doc.text_key || doc.id)?.toString() ?? doc.seed_text ?? '' : ''
  const priority=concernId=>{const matches=round().mappings.filter(map=>map.concern_id===concernId && !map.superseded && map.decision!=='rejected' && (map.response_spans || []).some(span=>span.document_id===doc?.id && verifiedResponseSpan(span,response)));return matches.some(map=>!map.stale && !map.needs_reconfirmation)?2:matches.length?1:0}
  const candidates=round().concerns.filter(concern=>!concern.superseded).flatMap(concern => (concern.source_spans || []).map(span=>({...span,concern_id:concern.id,priority:priority(concern.id)}))).filter(span => span.review_id === review.id && span.field === fieldName && Number.isInteger(span.start) && original.slice(span.start,span.end)===span.quote).sort((a,b) => b.priority-a.priority || a.start-b.start)
  const sources=[]
  for(const span of candidates)if(!sources.some(other=>span.start<other.end && span.end>other.start))sources.push(span)
  sources.sort((a,b)=>a.start-b.start)
  const spans = sources.map(span=>{if(value===original)return span;const aligned=alignedTranslation(review,fieldName,span.quote);return aligned?{...span,start:aligned.start,end:aligned.end}:null}).filter(Boolean).sort((a,b) => a.start-b.start)
  let output = '', cursor = 0
  for (const span of spans) { if (span.start < cursor) continue; output += esc(value.slice(cursor,span.start)) + `<mark class="connection-color-${connectionColorIndex(span.concern_id)} ${showAllConnections || selectedConcern===span.concern_id?'is-active':''}" tabindex="0" role="button" data-action="select-concern" data-id="${esc(span.concern_id)}" data-source-quote="${esc(span.quote)}" title="${esc(round().concerns.find(item=>item.id===span.concern_id)?.title)}">${esc(value.slice(span.start,span.end))}</mark>`; cursor = span.end }
  output += esc(value.slice(cursor))
  const collapsed = collapsedReviewFields.has(JSON.stringify([roundId, review.id, fieldName]))
  const contentId = `review-field-content-${reviewFieldIndex++}`
  return `<section class="review-field" data-review-id="${esc(review.id)}" data-review-field="${esc(fieldName)}" data-collapsed="${collapsed}"><h3><button type="button" class="review-field-toggle" aria-expanded="${!collapsed}" aria-controls="${contentId}"><span class="review-field-chevron" aria-hidden="true">▾</span><span>${esc(fieldName)}</span></button></h3><div id="${contentId}" class="review-field-body" aria-hidden="${collapsed}" ${collapsed?'inert':''}><div><div class="review-text" data-review-id="${esc(review.id)}" data-review-field="${esc(fieldName)}">${output}</div></div></div></section>`
}
function pendingImportTools() {
  const imports=round().imports.filter(item=>!['committed','discarded','deleted'].includes(item.status))
  if(!imports.length)return ''
  return `<div class="advanced-menu-group pending-import-tools"><h3>${t('Pending imports','미완료 가져오기')}</h3>${imports.map(item=>action('resume-import',item.raw?.filename || item.filename || t('Resume import','이어서 검토'),item.id)).join('')}</div>`
}
function responseAdvancedMenu(pending) {
  if($('review-advanced'))advancedOpen=$('review-advanced').open
  const tools = ['translate','style','consistency','simulate','rewrite'].map(task => action('analysis',taskText(task),task,'',Boolean(pending)))
  return `<details id="review-advanced" class="response-advanced" data-disclosure-menu ${advancedOpen?'open':''}><summary>${t('Advanced','고급')} <span aria-hidden="true">···</span></summary><div class="response-advanced-popover action-menu">${pendingImportTools()}<div class="advanced-menu-group"><h3>${t('Analysis','분석')}</h3>${tools.join('')}</div><div class="advanced-menu-group"><h3>${t('Response','답변')}</h3>${action('response-history',t('Version history','버전 이력'),'','',!documentFor())}</div><div class="advanced-menu-group"><h3>${t('Review','리뷰')}</h3>${action('edit-review-translations',t('Edit Korean translations','한국어 번역 편집'))}</div><div class="advanced-menu-group"><h3>${t('Concerns','우려 사항')}</h3>${action('new-concern',t('Add concern','우려 사항 추가'))}${action('merge-concerns',t('Merge / group','병합 / 그룹'))}</div><div class="advanced-menu-group"><a href="#overview">${t('Settings & activity','설정과 작업 기록')}</a><a href="#evidence">${t('Evidence & tasks','근거와 작업')}</a></div></div></details>`
}
let connectionDetailsCollapsed = window.PaperPreferenceStorage?.get('paper-rebuttal-connection-details-collapsed') === 'true'
let connectionDetailsResizeObserver
const savedConnectionHeight=Number(window.PaperPreferenceStorage?.get('paper-rebuttal-connection-details-height'))
let connectionDetailsHeight=Number.isFinite(savedConnectionHeight) && savedConnectionHeight>=0.15 && savedConnectionHeight<=0.75?savedConnectionHeight:0.25
function setConnectionDetailsHeight(value) {
  connectionDetailsHeight=Math.min(0.75,Math.max(0.15,value))
  const panel=document.querySelector('.source-panel'), handle=panel?.querySelector('.connection-details-resizer')
  if(panel)panel.style.setProperty('--connection-drawer-expanded-height',`${panel.clientHeight * connectionDetailsHeight}px`)
  handle?.setAttribute('aria-valuenow',String(Math.round(connectionDetailsHeight*100)))
  window.PaperPreferenceStorage?.set('paper-rebuttal-connection-details-height',String(connectionDetailsHeight))
  scheduleEdges()
}
function connectionDetailsHTML(concern) {
  return `<div class="connection-details-resizer" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="${t('Resize connection details','연결 설명 높이 조절')}" aria-valuemin="15" aria-valuemax="75" aria-valuenow="${Math.round(connectionDetailsHeight*100)}"></div><div class="connection-details-header"><button type="button" class="connection-details-toggle" data-action="toggle-connection-details" aria-controls="connection-details-body"><span>${t('Connection details','연결 설명')}</span><span class="connection-details-chevron" aria-hidden="true">▾</span></button></div><div id="connection-details-body" class="connection-details-body" tabindex="0">${concernHTML(concern)}</div>`
}
function syncConnectionDetailsCollapse() {
  const panel=document.querySelector('.source-panel'), details=panel?.querySelector('.selected-concern-result')
  if(!details)return
  panel.classList.toggle('details-collapsed',connectionDetailsCollapsed)
  const updateHeight=()=>panel.style.setProperty('--connection-drawer-expanded-height',`${panel.clientHeight * connectionDetailsHeight}px`)
  updateHeight()
  if(!connectionDetailsResizeObserver && typeof ResizeObserver==='function'){connectionDetailsResizeObserver=new ResizeObserver(updateHeight);connectionDetailsResizeObserver.observe(panel)}
  const button=details.querySelector('.connection-details-toggle')
  button.setAttribute('aria-expanded',String(!connectionDetailsCollapsed))
  button.setAttribute('aria-label',connectionDetailsCollapsed?t('Expand connection details','연결 설명 펼치기'):t('Collapse connection details','연결 설명 접기'))
  details.querySelector('.connection-details-resizer').hidden=connectionDetailsCollapsed
  const body=details.querySelector('.connection-details-body')
  body.setAttribute('aria-hidden',String(connectionDetailsCollapsed));body.inert=connectionDetailsCollapsed
  scheduleEdges()
}
function renderReviewsKeepingScroll() {
  const scrollTop = $('review-content')?.scrollTop || 0
  renderReviews()
  if ($('review-content')) $('review-content').scrollTop = scrollTop
}
function responseSourceStatus() {
  const doc=documentFor()
  return doc && session?.mapFor('rebuttalSourceStatus').get(doc.text_key || doc.id)
}
function responseSourceDetails() {
  const status=responseSourceStatus()
  if(!status)return ''
  return `<p>${t('Server response file (relative to the project folder):','서버 답변 파일 (프로젝트 폴더 기준):')}</p><pre class="export-preview">${esc(status.path)}</pre>${Array.isArray(status.conflictPaths) && status.conflictPaths.length?`<p>${t('Both versions were preserved. Review these files before combining the changes:','양쪽 원문을 보존했습니다. 변경을 합치기 전에 아래 파일을 비교하세요:')}</p><pre class="export-preview">${status.conflictPaths.map(esc).join('\n')}</pre>`:''}${status.recoveryPath?`<p>${t('Response preserved before the latest server change:','최근 서버 변경 반영 전에 보존한 답변:')}</p><pre class="export-preview">${esc(status.recoveryPath)}</pre>`:''}`
}
function renderResponseSourceStatus() {
  let host=$('response-source-status')
  if(!host && $('response-editor')){
    host=document.createElement('div');host.id='response-source-status';host.className='notice';host.setAttribute('role','status')
    $('response-editor').before(host)
  }
  if(!host)return
  const status=responseSourceStatus()
  host.hidden=!status || status.state==='synced'
  if(!host.hidden){
    const message=status.state==='conflict'
      ?t('Web and server edits overlapped. The server version is shown, and both versions have been preserved.','웹과 서버의 수정이 겹쳤습니다. 서버 내용을 표시하며 양쪽 원문을 보존했습니다.')
      :status.state==='missing'
        ?t('The server response file is missing. Your shared response has been kept; restore the file to resume synchronization.','서버 답변 파일이 없습니다. 공동 편집 본문은 유지했습니다. 파일을 복구하면 동기화가 재개됩니다.')
        :t('The response could not be synchronized with the server file. Your shared response is preserved. Check the file and its permissions.','서버 파일에 답변을 반영하지 못했습니다. 공동 편집 본문은 유지했습니다. 파일과 접근 권한을 확인하세요.')
    host.innerHTML=`<p>${message}</p><details><summary>${t('File locations','파일 위치')}</summary>${responseSourceDetails()}</details>`
  }
  renderSyncStatus()
}
function renderReviews() {
  const savedScroll=captureReviewScroll()
  connectionDetailsResizeObserver?.disconnect();connectionDetailsResizeObserver=null
  reviewFieldIndex = 0
  clearTimeout(pointerFocusTimer);pointerConnection = null; keyboardConnection = null
  savedReviewRange = null
  $('main').dataset.reviewView = 'reviews'
  const focusedControl = document.activeElement
  const r = round(), doc = documentFor(), reviews = r.reviews.filter(item => !currentReviewerId || item.reviewer_id === currentReviewerId)
  const concerns = currentReviewerId ? concernsForReviewer(currentReviewerId) : r.concerns.filter(concern=>!concern.superseded)
  if (selectedConcern && !concerns.some(item => item.id === selectedConcern)) selectedConcern = null
  const pending = (state.jobs || []).find(job => job.round_id === roundId && ['queued','running'].includes(job.status))
  const relevantJobs = (state.jobs || []).filter(job => job.round_id === roundId && ['connect','map','analyze'].includes(job.task) && (!job.scope?.document_ids?.length || job.scope.document_ids.includes(currentDocId)))
  const checkJob = relevantJobs.find(job => job.id === checkJobId) || relevantJobs.slice().sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || '')))[0]
  const selected = concerns.find(item => item.id === selectedConcern)
  const missingTranslations=reviews.reduce((count,review)=>count+Object.keys(review.fields || {}).filter(name=>!review.translations?.[name]?.trim()).length,0)
  const findingCount = r.findings.filter(item => item.status !== 'rejected').length + (state.jobs || []).filter(job => !job.round_id || job.round_id===roundId).reduce((count,job)=>count+(Array.isArray(job.result?.consistency)?job.result.consistency.length:0),0)
  $('main').innerHTML = `<div class="review-context-bar"><label class="connection-option switch-label"><input type="checkbox" role="switch" id="show-all-connections" ${showAllConnections?'checked':''}>${t('Show all connections','모든 연결 보기')}</label><div class="actions">${action('check-response',pending?t('Checking…','점검 중…'):t('Review–response connections','리뷰–답변 연결'),'','primary',checkSubmitting || Boolean(pending) || !r.reviews.length || !r.documents.length || !sessionReady)}</div></div><div id="review-translation-status" role="status">${koreanReview && missingTranslations?`<p class="translation-status small muted">${t('Some sections have no Korean translation yet; their original text is shown.','아직 번역이 없는 항목은 원어로 표시합니다.')} ${action('translate-reviews',t('Translate reviews into Korean','리뷰 전체 한국어로 번역'),'','',Boolean(pending))}</p>`:''}</div><div id="response-check-status" role="status">${checkJob?.status==='failed'?`<div class="check-status error">${badge(statusText(checkJob.status),'warn')}${checkJob.error?`<span>${esc(typeof checkJob.error==='string'?checkJob.error:checkJob.error.message)}</span>`:''}</div>`:checkJob?.status==='completed' && checkJob.connection_warnings?.length && checkJob.scope?.document_ids?.includes(currentDocId)?`<div class="check-status">${badge(t('Partial','일부 완료'),'warn')}<span>${checkJob.connection_warnings.some(warning=>warning.contextual_links>0)?t('Some connections could only be kept as context. Review them before confirming.','일부 연결은 문맥 관계로만 유지했습니다. 확인 후 확정해 주세요.'):t('Some proposed links did not pass verification and were omitted. Existing links were retained.','일부 연결은 검증을 통과하지 못해 제외했습니다. 기존 연결은 유지했습니다.')}</span></div>`:''}</div><div class="review-workspace" id="mapping-workspace"><section class="panel source-panel"><div class="panel-header"><div class="review-title-controls"><h2>${t('Review','리뷰')}</h2><div id="review-language" class="review-language-switch" role="group" aria-label="${t('Review language','리뷰 언어')}"><button type="button" data-review-language="original" aria-pressed="${!koreanReview}">${t('Original','원어')}</button><button type="button" data-review-language="ko" aria-pressed="${koreanReview}">${t('Korean','한국어')}</button></div></div></div><div class="selection-tray" id="source-selection-tray" ${sourceSelections.length?'':'hidden'}></div><div class="review-content" id="review-content"><div class="document-heading"><h3>${esc(reviewerName(currentReviewerId))}</h3></div>${reviews.length?reviews.map(review=>Object.entries(review.fields || {}).map(([name,text])=>reviewFieldHTML(review,name,text)).join('')).join('<hr>'):`<div class="empty"><p>${t('Import reviews to begin.','리뷰를 가져와 시작하세요.')}</p>${action('import',t('Import reviews','리뷰 가져오기'),'','primary')}</div>`}</div></section><div id="review-panel-resizer" class="review-panel-resizer workspace-resizer" role="separator" tabindex="0" aria-orientation="vertical" aria-label="${t('Resize review and response panels','리뷰와 답변 패널 크기 조절')}" aria-valuemin="25" aria-valuemax="75" aria-valuenow="45"></div><section class="panel response-panel"><div class="panel-header"><div class="review-title-controls"><h2>${t('Response','답변')}</h2><div class="review-language-switch" role="group" aria-label="${t('Response language','답변 언어')}"><button type="button" data-answer-language="en" aria-pressed="${answerLanguage==='en'}">English</button><button type="button" data-answer-language="ko" aria-pressed="${answerLanguage==='ko'}">한국어</button></div><button type="button" class="response-preview-toggle" data-response-view="toggle" aria-pressed="${responsePreview}" aria-label="${t('OpenReview preview','OpenReview 미리보기')}"><span>OpenReview</span></button></div><div class="response-header-right"><div id="review-collaborators" class="review-collaborators" role="group" aria-label="${t('People viewing this response','이 답변을 함께 보는 사람')}" hidden></div><button type="button" id="response-memos-toggle" class="response-memos-button" aria-expanded="false" aria-controls="response-memos-panel" ${!sessionReady?'disabled':''}>${t('Notes','메모')} <span id="response-memos-count"></span></button>${responseAdvancedMenu(pending)}</div></div><div class="response-document-heading document-heading"><h3>${esc(doc?.title || t('Your response','답변 작성'))}</h3></div><div id="response-editor" class="editor-host"><div id="response-memo-anchors" class="response-memo-anchors" aria-hidden="false"></div><button type="button" id="response-memo-add" class="response-memos-button" hidden>${t('Add note','메모 추가')}</button>${!doc?`<div class="empty"><h3>${t('Write a response to this reviewer','이 리뷰어에게 답변하기')}</h3><p>${t('Start a response document to write alongside the original review.','답변 문서를 시작하면 원문을 보며 작성할 수 있습니다.')}</p>${action('start-response',t('Start response','답변 시작'),'','primary',!currentReviewerId)}</div>`:''}</div><div id="response-check-progress" class="response-check-progress" role="status" aria-live="polite" hidden><span class="response-check-spinner" aria-hidden="true"></span><span>${t('Connecting the review and response…','리뷰와 답변을 연결하고 있어요…')}</span><button type="button" class="response-check-cancel" data-action="cancel-job" hidden>${t('Cancel','취소')}</button></div><section id="response-korean" class="response-korean" hidden><div data-ko-text class="response-korean-text"></div><div class="response-korean-actions"><span data-ko-status role="status"></span><span data-ko-alignment-status role="status"></span><button type="button" data-action="translate-response-ko" ${readOnly?'disabled':''} hidden>${t('Translate','번역하기')}</button></div></section><div id="response-preview" class="response-preview" hidden></div>${findingCount?`<details id="response-findings" class="response-findings" ${findingsOpen?'open':''}><summary>${t('Review findings','점검 결과')} <span class="badge">${findingCount}</span></summary><div class="response-findings-body">${findingsHTML()}</div></details>`:''}<div class="editor-footer" ${answerLanguage==='ko'?'hidden':''}><span id="response-count"></span><span>${readOnly?t('Read only','읽기 전용'):sessionReady?'':t('Connecting…','연결 중…')}</span></div><div id="response-selection-tray" class="selection-tray" ${responseSelections.length?'':'hidden'}></div></section><div id="response-memos-resizer" class="response-memos-resizer workspace-resizer" role="separator" tabindex="0" aria-orientation="vertical" aria-label="${t('Resize notes panel','메모 패널 크기 조절')}" hidden></div><section id="response-memos-panel" class="response-memos-panel" aria-label="${t('Notes','메모')}" hidden><div class="response-memos-heading"><button type="button" class="response-memos-close" data-memo-action="close" aria-label="${t('Close notes','메모 닫기')}">×</button></div><div id="rebuttal-memo-list" class="response-memo-list"></div><div class="response-memo-composer"><div id="rebuttal-memo-selected" class="response-memo-selected" hidden></div><textarea id="rebuttal-memo-input" class="response-memo-input" maxlength="4000" placeholder="${t('Write a note','메모를 입력하세요')}"></textarea><div class="response-memo-actions"><button type="button" data-memo-action="clear">${t('Clear selection','선택 해제')}</button><button type="button" class="primary" data-memo-action="save" ${readOnly?'disabled':''}>${t('Save note','메모 저장')}</button></div></div></section><svg class="edge-layer" id="mapping-edges" role="group" aria-label="${t('Concern to response connections','우려 사항과 답변의 연결')}"></svg></div>${selected?`<section class="selected-concern-result" aria-label="${t('Selected concern','선택한 우려 사항')}" data-concern-id="${esc(selected.id)}">${connectionDetailsHTML(selected)}</section>`:''}`
  const selectedResult=document.querySelector('.selected-concern-result')
  if(selectedResult){const sourcePanel=document.querySelector('.source-panel');sourcePanel.classList.add('has-selected-concern');sourcePanel.append(selectedResult);syncConnectionDetailsCollapse()}
  if (doc && sessionReady && sharedTexts.has(doc.text_key || doc.id)) { ensureEditor(); $('response-editor').dataset.documentId=doc.id; $('response-editor').append(editor.dom); editor.setDocument(doc.id,texts()[doc.id]); editor.contentDOM.setAttribute('aria-label',t('Response text','답변 본문')); updateHighlights() }
  else if (doc) $('response-editor').innerHTML=`<div class="empty" role="status"><p>${textBindingError?esc(t('Response editing is unavailable: ','답변 편집을 준비하지 못했습니다: ')+textBindingError):t('Preparing response editing…','답변 편집 준비 중…')}</p>${textBindingError?action('retry-response-texts',t('Retry','다시 시도')):''}</div>`
  let width = Number(window.PaperPreferenceStorage?.get('paper-rebuttal-review-width')) || 45
  setReviewPanelWidth(width)
  window.PaperUI.bindResizer({
    element:$('review-panel-resizer'),step:5,enabled:()=>innerWidth>=768,
    getValue:()=>width,
    getLimits:()=>({min:25,max:75}),
    fromPointer:event=>{const workspace=$('mapping-workspace'),bounds=workspace.getBoundingClientRect(),memo=$('response-memos-panel');const available=bounds.width-(innerWidth>=1200 && memo && !memo.hidden ? memo.getBoundingClientRect().width + 8 : 0);return (event.clientX-bounds.left)/available*100},
    onChange:value=>{width=setReviewPanelWidth(value);scheduleEdges()},
    onCommit:()=>window.PaperPreferenceStorage.set('paper-rebuttal-review-width',String(width))
  })
  $('review-advanced').addEventListener('toggle',event=>{advancedOpen=event.target.open})
  $('response-findings')?.addEventListener('toggle',event=>{findingsOpen=event.target.open;editor?.requestMeasure?.();scheduleEdges()})
  setResponsePreview(responsePreview && Boolean(doc)); void mountKorean(); syncResponseCheck(); renderReviewerNav(); renderSelections(); updateMechanical(); scheduleEdges(); updateFreshnessUI()
  if(sessionReady){comments.init(session);comments.mount()}
  const reviewContent=$('review-content');let scrollIndicatorTimer
  reviewContent.addEventListener('scroll',()=>{scheduleEdges();reviewContent.classList.add('is-scrolling');clearTimeout(scrollIndicatorTimer);scrollIndicatorTimer=setTimeout(()=>reviewContent.classList.remove('is-scrolling'),1000)},{passive:true})
  $('response-preview').addEventListener('scroll',scheduleEdges,{passive:true})
  $('response-korean').addEventListener('scroll',scheduleEdges,{passive:true})
  restoreControlFocus(focusedControl)
  restoreReviewScroll(savedScroll)
  syncReviewPresence()
  renderResponseSourceStatus()
}
function setReviewPanelWidth(value) {
  const width = Math.min(75,Math.max(25,value))
  $('mapping-workspace')?.style.setProperty('--review-column',`${width}%`)
  $('mapping-workspace')?.style.setProperty('--review-column-ratio',String(width/100))
  $('review-panel-resizer')?.setAttribute('aria-valuenow',String(Math.round(width)))
  return width
}
function concernHTML(concern) {
  const seen=new Set(), mappings=round().mappings.filter(map=>!map.superseded && map.concern_id===concern.id).reverse().filter(map=>{const key=JSON.stringify((map.response_spans || []).map(span=>[span.document_id,span.quote]));if(seen.has(key))return false;seen.add(key);return true}).reverse()
  const selected = selectedConcern === concern.id
  const source = (concern.source_spans || []).map(span=>{
    const review=round().reviews.find(item=>item.id===span.review_id)
    const pair=alignedTranslation(review,span.field,span.quote)
    const translated=review?.translations?.[span.field]?.trim()
    const translation=pair?`<p class="detail-label">${t('Korean translation','한국어 번역')}</p><blockquote>${esc(pair.text)}</blockquote>`:translated?`<p class="detail-label">${t('Korean translation of this review section','해당 리뷰 섹션의 한국어 번역')}</p><blockquote>${esc(translated)}</blockquote>`:`<p class="detail-label">${t('Korean translation','한국어 번역')}</p><p class="small muted">${t('No translation is available for this section.','이 섹션의 번역이 아직 없습니다.')}</p>`
    return `<div class="concern-source-pair"><p class="detail-label">${t('Review original','리뷰 원문')}</p><blockquote>${esc(span.quote)}</blockquote>${selected?`<div class="concern-translation">${translation}</div>`:''}</div>`
  }).join('')

  const mappingHTML = mappings.map(mapping => {
    const replies = (mapping.response_spans || []).map(span=>{
      const value=texts()[span.document_id],doc=round().documents.find(item=>item.id===span.document_id),aligned=answerLanguage==='ko'?koreanResponseRange(span,doc):null
      const available=sessionReady && typeof value==='string' && Boolean(verifiedResponseSpan(span,value)) && (answerLanguage!=='ko' || Boolean(aligned))
      return `<button type="button" class="mapping-quote text-link" data-action="focus-span" data-id="${esc(mapping.id)}" data-document="${esc(span.document_id)}" data-source-quote="${esc(span.quote)}" ${available?'':'disabled'}>${esc(aligned?.text || span.quote)}</button>`
    }).join('')
    return `<div class="mapping activity-entry" data-mapping-id="${esc(mapping.id)}" tabindex="0"><div class="mapping-content">${mapping.relationship?badge(({direct:t('Direct response','직접 답변'),partial:t('Partial response','부분 답변'),context:t('Related context','관련 맥락')})[mapping.relationship] || ''):''}<p class="mapping-stale-note" data-stale-note hidden>${t('The quoted passage is from an earlier response and is no longer present.','이 구절은 이전 답변에 있었으며 현재 답변에는 없습니다.')}</p><p class="detail-label">${t('Why connected','연결 이유')}</p><p class="mapping-reason">${esc(mapping.reason || t('No explanation provided.','연결 이유가 제공되지 않았습니다.'))}</p>${replies?`<p class="detail-label">${t('Response passage','답변 구절')}</p><div class="mapping-replies">${replies}</div>`:''}${mapping.missing?.length?`<p class="mapping-missing">${t('Missing','누락')}: ${mapping.missing.map(esc).join('; ')}</p>`:''}</div></div>`
  }).join('')
  const staleNotice=`<div class="connection-stale-notice" data-connection-stale-notice hidden><p>${t('The response has changed, so some previous connections cannot be shown. Run the connection check again to find the current passages.','답변이 바뀌어 일부 기존 연결을 표시할 수 없습니다. 현재 구절을 찾으려면 연결을 다시 분석하세요.')}</p>${action('check-response',t('Recheck connections','연결 다시 분석'),'','',checkSubmitting || (state.jobs || []).some(job=>job.round_id===roundId && ['queued','running'].includes(job.status)) || !sessionReady)}</div>`
  return `<article class="concern connection-color-${connectionColorIndex(concern.id)} ${selected?'selected':''}" data-concern-id="${esc(concern.id)}"><header class="concern-header"><button type="button" class="concern-title" data-action="select-concern" data-id="${esc(concern.id)}" aria-pressed="${selected}"><span class="concern-title-text">${esc(concern.title)}</span></button></header>${concern.group || concern.assignee || concern.requires_response===false ? `<div class="concern-properties">${concern.group?badge(concern.group):''}${concern.assignee?badge(concern.assignee):''}${concern.requires_response===false?badge(t('No response needed','답변 불필요')):''}</div>` : ''}${source?`<div class="concern-source">${source}</div>`:''}<div class="concern-mappings">${staleNotice}${mappingHTML || `<p class="mapping-empty">${t('No response linked yet.','아직 연결된 답변이 없습니다.')}</p>`}</div></article>`
}
function findingsHTML() {
  const findings = round().findings.filter(item => item.status !== 'rejected')
  const supplemental = (state.jobs || []).filter(job=>!job.round_id || job.round_id===roundId).flatMap(job=>(job.result?.consistency || []).map(item=>`<div class="finding"><strong>${t('Cross-document consistency','문서 간 일관성')}</strong><p>${esc(item.reason)}</p>${(item.quotes || []).map(quote=>`<blockquote>${esc(typeof quote==='string'?quote:quote.quote)}</blockquote>`).join('')}<p class="diff-after">${esc(item.suggestion)}</p></div>`)).join('')
  if (!findings.length && !supplemental) return `<p class="muted small">${t('Run a wording or consistency check when ready. Suggestions require your review.','준비가 되면 표현 또는 일관성을 점검하세요. 제안은 검토 후 적용합니다.')}</p>`
  return supplemental + findings.map(finding=>`<div class="finding" data-finding-id="${esc(finding.id)}"><strong>${esc(finding.type || '')}</strong> <span data-finding-state>${badge(finding.stale?statusText('stale'):statusText(finding.status))}</span><p>${esc(finding.reason)}</p><blockquote>${esc(finding.quote)}</blockquote><p class="diff-after">${esc(finding.suggestion)}</p>${finding.meaning_change?badge(t('Meaning may change','의미 변경 가능'),'warn'):''}<div class="actions">${action('apply-finding',t('Review & apply','검토 후 적용'),finding.id,'',finding.stale || finding.status==='stale')}${action('reject-finding',t('Dismiss','제외'),finding.id)}</div></div>`).join('')
}
function renderSelections() {
  const source = $('source-selection-tray'), response = $('response-selection-tray')
  if (source) { source.hidden = !sourceSelections.length; source.innerHTML = sourceSelections.map(span=>`<blockquote>${esc(span.quote)}</blockquote>`).join('')+action('clear-source',t('Clear passages','선택 해제')) }
  if (response) { response.hidden = !responseSelections.length; response.innerHTML = responseSelections.map(span=>`<blockquote>${esc(span.quote)}</blockquote>`).join('')+action('clear-response',t('Clear passages','선택 해제')) }
}
function hasVisibleConnectionSource(mapping) {
  const concern=round()?.concerns.find(item=>item.id===mapping.concern_id && !item.superseded)
  const roots=[...document.querySelectorAll('#review-content .review-text')]
  return (concern?.source_spans || []).some(span=>{
    const root=roots.find(node=>node.dataset.reviewId===span.review_id && node.dataset.reviewField===span.field)
    return root && root.closest('.review-field')?.dataset.collapsed!=='true' && [...root.querySelectorAll('mark[data-id]')].some(mark=>mark.dataset.id===mapping.concern_id && mark.dataset.sourceQuote===span.quote)
  })
}
function updateHighlights() {
  if(answerLanguage==='ko' && documentFor())renderKoreanStatus(documentFor())
  if (!editor || !round()) return
  const value = editor.getValue(), spans = round().mappings.filter(map=>!map.superseded && map.decision!=='rejected' && (showAllConnections || selectedConcern && map.concern_id===selectedConcern) && hasVisibleConnectionSource(map)).flatMap(map=>(map.response_spans || []).filter(span=>span.document_id===currentDocId).map(span=>({ ...verifiedResponseSpan(span,value), id:map.id,concernId:map.concern_id,color:connectionColorIndex(map.concern_id),reason:map.reason }))).filter(span=>Number.isInteger(span.start))
  editor.setHighlights(spans)
}
let edgesFrame
let pointerConnection = null, keyboardConnection = null
let pointerFocusTimer
let dismissedHoverConcern = null
function connectionTarget(target) {
  if (!(target instanceof Element)) return null
  const node=target.closest('.review-text mark.is-active[data-id], .rebuttal-span[data-concern-id], .mapping-edge-hit')
  if (!node) return null
  const data=node.matches('.mapping-edge-hit') ? node.parentElement?.dataset : node.dataset
  const concernId=data?.concernId || data?.id, mappingId=data?.mappingId || null
  return concernId ? {concernId,mappingId,key:JSON.stringify([concernId,mappingId])} : null
}
function updateConnectionFocus() {
  const host=$('mapping-workspace'), candidate=pointerConnection || keyboardConnection
  const active=candidate?.concernId===dismissedHoverConcern?null:candidate
  if (!host) return
  host.classList.toggle('connection-focus-active',Boolean(active))
  for(const node of host.querySelectorAll('.review-text mark[data-id], .rebuttal-span[data-concern-id], #mapping-edges g[data-concern-id]')) {
    const sameConcern=(node.dataset.concernId || node.dataset.id)===active?.concernId
    const sameMapping=!active?.mappingId || !node.dataset.mappingId || node.dataset.mappingId===active.mappingId
    node.classList.toggle('is-focused-connection',Boolean(active) && sameConcern && sameMapping)
  }
}
function showHoveredConnectionDetails(concernId) {
  if(selectedConcern)return
  const panel=document.querySelector('.source-panel'), host=$('mapping-workspace')
  const concern=round()?.concerns.find(item=>item.id===concernId && !item.superseded)
  if(!panel || !host || !concern)return
  let details=panel.querySelector('.selected-concern-result')
  if(details?.dataset.concernId===concernId)return
  if(!details){details=document.createElement('section');details.className='selected-concern-result';details.setAttribute('aria-label',t('Selected concern','선택한 우려 사항'));panel.classList.add('has-selected-concern');panel.append(details)}
  details.dataset.concernId=concernId;details.innerHTML=connectionDetailsHTML(concern)
  syncConnectionDetailsCollapse();updateFreshnessUI();scheduleEdges()
}
function scheduleEdges() { cancelAnimationFrame(edgesFrame); edgesFrame = requestAnimationFrame(drawEdges) }
const movingReviewFields = new Set()
let reviewFieldEdgeFrame = 0
function animateReviewFieldEdges() {
  for (const field of movingReviewFields) if (!field.isConnected) movingReviewFields.delete(field)
  drawEdges()
  reviewFieldEdgeFrame = movingReviewFields.size ? requestAnimationFrame(animateReviewFieldEdges) : 0
}
function drawEdges() {
  const svg = $('mapping-edges'), host = $('mapping-workspace')
  if (!svg) return
  svg.replaceChildren()
  let tooltip = $('mapping-edge-tooltip')
  if (!tooltip && host) { tooltip=document.createElement('div');tooltip.id='mapping-edge-tooltip';tooltip.className='mapping-edge-tooltip';tooltip.setAttribute('role','tooltip');tooltip.hidden=true;host.append(tooltip) }
  if (tooltip) tooltip.hidden=true
  if (!host || !editor || innerWidth < 1191) return
   const rect = host.getBoundingClientRect(); svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`)
  const appendEdge=(x1,y1,x2,y2,map,opacity,collapsed)=>{
    const ns='http://www.w3.org/2000/svg',group=document.createElementNS(ns,'g'),line=document.createElementNS(ns,'path'),hit=document.createElementNS(ns,'path')
    const d=`M${x1},${y1} C${x1+24},${y1} ${x2-24},${y2} ${x2},${y2}`,reason=map.reason?.trim() || t('No explanation provided.','연결 이유가 제공되지 않았습니다.')
    group.setAttribute('class',`connection-color-${connectionColorIndex(map.concern_id)}${selectedConcern===map.concern_id?' is-selected-connection':''}`);group.dataset.concernId=map.concern_id;group.dataset.mappingId=map.id;group.style.opacity=String(opacity)
    line.setAttribute('d',d);line.setAttribute('class','mapping-edge-line')
    hit.setAttribute('d',d);hit.setAttribute('class','mapping-edge-hit');hit.setAttribute('tabindex',collapsed?'-1':'0');hit.setAttribute('role','button');hit.setAttribute('aria-label',`${t('Connection reason','연결 이유')}: ${reason}`);hit.setAttribute('aria-describedby','mapping-edge-tooltip');if(collapsed)hit.style.pointerEvents='none'
    const show=event=>{tooltip.textContent=reason;tooltip.hidden=false;const anchor=event?.clientX ? {x:event.clientX-rect.left,y:event.clientY-rect.top} : {x:(x1+x2)/2,y:(y1+y2)/2};tooltip.style.left=`${Math.max(8,Math.min(anchor.x+12,rect.width-tooltip.offsetWidth-8))}px`;tooltip.style.top=`${Math.max(8,Math.min(anchor.y+12,rect.height-tooltip.offsetHeight-8))}px`}
    hit.addEventListener('pointerenter',show);hit.addEventListener('pointermove',show);hit.addEventListener('pointerleave',()=>{tooltip.hidden=true});hit.addEventListener('focus',show);hit.addEventListener('blur',()=>{tooltip.hidden=true})
    hit.onclick=()=>{tooltip.hidden=true;mappingDetails(map.id)};hit.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();tooltip.hidden=true;mappingDetails(map.id)}};group.append(line,hit);svg.append(group)
  }

  for (const map of round().mappings.filter(item=>!item.superseded && item.decision!=='rejected' && (showAllConnections || selectedConcern && item.concern_id===selectedConcern))) {
    for (const span of map.response_spans || []) {
      if (span.document_id !== currentDocId) continue
      const verified = verifiedResponseSpan(span,editor.getValue()); if (!verified) continue
      const translated=answerLanguage==='ko', target=translated?(responsePreview?$('response-preview'):$('response-korean')):(responsePreview?$('response-preview'):editor.dom)
      const mark=translated || responsePreview ? [...(target?.querySelectorAll('.rebuttal-span') || [])].find(node=>node.dataset.mappingId===map.id) : null
      const bounds = target?.getBoundingClientRect(), coord=translated || responsePreview?mark?.getBoundingClientRect():editor.coordsAt(verified.start); if (!bounds || !coord || coord.top < bounds.top || coord.top > bounds.bottom) continue
      const sourceSpans=round().concerns.find(item=>item.id===map.concern_id)?.source_spans || []
      for(const source of sourceSpans){
        const root=[...document.querySelectorAll('.review-text')].find(node=>node.dataset.reviewId===source.review_id && node.dataset.reviewField===source.field)
        const mark=root && [...root.querySelectorAll('mark')].find(node=>node.dataset.id===map.concern_id && node.dataset.sourceQuote===source.quote)
        if(!mark)continue
        const field=mark.closest('.review-field'),body=mark.closest('.review-field-body'),collapsed=field?.dataset.collapsed==='true',opacity=body?Number(getComputedStyle(body).opacity):1
        if(opacity<=0.01)continue
        const sourceRect=mark.getBoundingClientRect(),reviewBounds=$('review-content').getBoundingClientRect()
        if(sourceRect.top<reviewBounds.top || sourceRect.bottom>reviewBounds.bottom)continue
        appendEdge(sourceRect.right-rect.left,sourceRect.top-rect.top+sourceRect.height/2,bounds.left-rect.left+8,coord.top-rect.top+8,map,opacity,collapsed)
      }
    }
  }
  updateConnectionFocus()
}
function renderEvidence() {
  const r = round()
  const list = (items, kind) => items.length ? items.map(item=>`<article class="item-row"><div><strong>${esc(item.title || item.description)}</strong><p class="small muted">${esc(item.description || item.body || '')}</p><div class="actions">${badge(statusText(item.status || 'todo'))}${item.assignee?badge(item.assignee):''}${item.concern_id?badge(r.concerns.find(concern=>concern.id===item.concern_id)?.title || ''):''}</div>${item.url && /^https?:\/\//.test(item.url)?`<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="small">${esc(item.url)}</a>`:''}${(item.comments || []).map(comment=>`<p class="small"><strong>${esc(comment.author || comment.actor || '')}</strong> ${esc(comment.text || comment.body || '')}</p>`).join('')}</div><div class="actions">${action(`edit-${kind}`,t('Edit','편집'),item.id)}${action(`comment-${kind}`,t('Comment','댓글'),item.id)}</div></article>`).join('') : `<p class="empty">${t('Nothing added yet.','아직 추가된 항목이 없습니다.')}</p>`
  $('main').innerHTML = `<div class="grid"><section class="card"><div class="card-header"><div><p class="eyebrow">EVIDENCE</p><h2>${t('Support every claim','주장을 뒷받침하는 근거')}</h2></div>${action('new-evidence',t('＋ Evidence','＋ 근거'),'','primary')}</div><p class="small muted">${t('Connect experiments, citations and verification notes to reviewer concerns.','실험, 인용 문헌, 검증 메모를 리뷰어의 우려 사항과 연결하세요.')}</p>${list(r.evidence,'evidence')}</section><section class="card"><div class="card-header"><div><p class="eyebrow">WORK ITEMS</p><h2>${t('Move the response forward','답변 완성을 위한 작업')}</h2></div>${action('new-work',t('＋ Task','＋ 작업'))}</div><p class="small muted">${t('Assign owners and track work independently from AI coverage suggestions.','담당자를 배정하고 작업 진행 상태를 관리하세요.')}</p>${list(r.work_items,'work')}</section></div>`
}
function showDialog(title, html, submit, saveLabel = t('Save','저장')) {
  dialogSubmit = submit
  dialogRoundSnapshot = round() ? clone(round()) : null
  $('dialog-title').textContent=title; $('dialog-body').innerHTML=html
  dialogInitialValues = new FormData($('dialog-form'))
  $('dialog-save').textContent=saveLabel; $('dialog-save').hidden=!submit; $('dialog-save').disabled=false
  $('dialog-cancel').textContent=submit?t('Cancel','취소'):t('Close','닫기'); $('dialog-close').setAttribute('aria-label',t('Close','닫기')); $('dialog-error').hidden=true
  window.PaperUI.openDialog($('form-dialog'),{onReturnFocus:restoreControlFocus})
}
function changedFormFields(data, values) {
  return Object.fromEntries(Object.entries(values).filter(([key,value])=>typeof value==='boolean' ? data.has(key)!==dialogInitialValues.has(key) : data.get(key)!==dialogInitialValues.get(key)))
}
function closeDialog() { $('form-dialog').close() }
$('form-dialog').addEventListener('click',event=>{
  const dialog=event.currentTarget
  if(event.target!==dialog || !dialog.querySelector('.mate-picker'))return
  const bounds=dialog.getBoundingClientRect()
  if(event.clientX<bounds.left || event.clientX>bounds.right || event.clientY<bounds.top || event.clientY>bounds.bottom)closeDialog()
})
async function guard(fn) { try { return await fn() } catch(error) { notice(error.message,true) } }
async function newRound() { showDialog(t('Create rebuttal round','Rebuttal 라운드 만들기'),field('title',t('Round title','라운드 이름'),`Round ${state.rounds.length+1}`),async data=>{const title=data.get('title').trim();if(!title)throw new Error(t('Enter a title.','이름을 입력하세요.'));const previous=new Set(state.rounds.map(r=>r.id));await mutate('/rounds',{title});roundId=state.rounds.find(r=>!previous.has(r.id))?.id || roundId;targetIds=null;currentDocId=null;updateRoundURL(true);renderAll()}) }
function newDocument() {
  const ids=reviewerIds()
  showDialog(t('Add response document','답변 문서 추가'),field('title',t('Document title','문서 제목'),t('Response to reviewer','리뷰어 답변'))+selectField('kind',t('Type','종류'),[['reviewer',t('Reviewer response','리뷰어별 답변')],['common',t('Common response (optional)','공통 답변 (선택)')],['unified',t('Unified response','통합 답변')]],'reviewer')+selectField('reviewer_id',t('Reviewer','리뷰어'),[['',t('Unassigned','지정 안 함')],...ids.map(id=>[id,reviewerName(id)])],currentReviewerId),async data=>{await mutate(`/rounds/${roundId}/documents`,{title:data.get('title'),kind:data.get('kind'),reviewer_id:data.get('kind')==='reviewer'?data.get('reviewer_id') || null:null});currentDocId=round().documents.at(-1)?.id;screen='reviews';renderAll()})
}
function captureSource() {
  if(koreanReview)throw new Error(t('Switch to the original review to anchor an exact source passage.','정확한 원문 구절을 연결하려면 리뷰 원문으로 전환하세요.'))
  const selection=window.getSelection()
  const range=selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : savedReviewRange
  if(!range || range.collapsed)throw new Error(t('Select a passage in the review first.','리뷰에서 구절을 먼저 선택하세요.'))
  const root=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement)?.closest('.review-text')
  if(!root?.isConnected || !root.contains(range.endContainer))throw new Error(t('Select a passage within one review field.','하나의 리뷰 항목 안에서 구절을 선택하세요.'))
  const prefix=range.cloneRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset)
  const start=prefix.toString().length,end=start+range.toString().length
  const review=round().reviews.find(item=>item.id===root.dataset.reviewId), text=review.fields[root.dataset.reviewField]
  const span={review_id:review.id,field:root.dataset.reviewField,start,end,quote:text.slice(start,end)}
  if(!span.quote || span.quote!==range.toString())throw new Error(t('The passage changed. Select it again.','구절이 변경되었습니다. 다시 선택하세요.'))
  sourceSelections.push(span);savedReviewRange=null;renderSelections();selection?.removeAllRanges()
}
function captureResponse() {
  if(!editor || !documentFor())throw new Error(t('Open a response document first.','답변 문서를 먼저 여세요.'))
  const {start,end}=editor.getSelection();if(start===end)throw new Error(t('Select a passage in the response first.','답변 본문에서 구절을 먼저 선택하세요.'))
  const shared=sharedTexts.get(documentFor().text_key || currentDocId)
  responseSelections.push({document_id:currentDocId,start,end,quote:editor.getValue().slice(start,end),...session.encodeTextRange(shared,start,end)});renderSelections()
}
function editConcern(id) {
  const item=round().concerns.find(concern=>concern.id===id)
  showDialog(item?t('Edit concern','우려 사항 편집'):t('Add concern','우려 사항 추가'),field('title',t('Concern','우려 사항'),item?.title || '')+selectField('reviewer_id',t('Reviewer','리뷰어'),[['',t('General','전체')],...reviewerIds().map(id=>[id,reviewerName(id)])],item?.reviewer_id || currentReviewerId)+`<div class="form-grid">${selectField('strategy',t('Response strategy','답변 전략'),[['clarify',t('Clarify','명확히 설명')],['accept',t('Accept','수용')],['dispute',t('Dispute','반론')],['scope',t('Explain scope','범위 설명')]],item?.strategy || 'clarify')}${selectField('work_status',t('Work status','작업 상태'),['todo','review','confirmed'].map(value=>[value,statusText(value)]),item?.work_status || 'todo')}${field('assignee',t('Assignee','담당자'),item?.assignee || '')}${field('group',t('Group','그룹'),item?.group || '')}${field('priority',t('Priority','우선순위'),item?.priority || '')}</div>${checkbox('requires_response',t('Requires a response','답변 필요'),item?.requires_response!==false)}<div class="form-help">${t('Attached source passages','연결할 원문 구절')}: ${(item?.source_spans || sourceSelections).map(span=>esc(span.quote)).join(' · ') || t('None selected','선택 없음')}</div>`,async data=>{
    const values={title:data.get('title').trim(),reviewer_id:data.get('reviewer_id') || null,strategy:data.get('strategy'),work_status:data.get('work_status'),assignee:data.get('assignee'),group:data.get('group'),priority:data.get('priority'),requires_response:data.has('requires_response')}
    const concern=item?{...item,...changedFormFields(data,values)}:{id:uid(),source_spans:clone(sourceSelections),comments:[],...values}
    if(!concern.title)throw new Error(t('Enter a concern.','우려 사항을 입력하세요.'))
    await updateRound(r=>{if(item){r.concerns=r.concerns.map(c=>c.id===id?concern:c);if(item.title!==concern.title || item.strategy!==concern.strategy || item.requires_response!==concern.requires_response)r.mappings.forEach(map=>{if(map.concern_id===id){map.stale=true;map.needs_reconfirmation=true;map.decision='proposed'}})}else r.concerns.push(concern)});selectedConcern=concern.id;sourceSelections=[];renderAll()
  })
}
function splitConcern(id) {
  const item=round().concerns.find(concern=>concern.id===id)
  showDialog(t('Split concern','우려 사항 분리'),field('titles',t('One concern per line','줄마다 우려 사항 하나씩'),item.title+'\n','textarea')+`<p class="form-help">${t('The parent and its existing links remain. New concerns inherit the source passages.','기존 우려 사항과 연결은 유지하며 새 우려 사항에 원문 구절을 이어받습니다.')}</p>`,async data=>{const titles=data.get('titles').split('\n').map(value=>value.trim()).filter(Boolean);if(titles.length<2)throw new Error(t('Enter at least two concerns.','두 개 이상의 우려 사항을 입력하세요.'));await updateRound(r=>{r.concerns.push(...titles.map(title=>({...clone(item),id:uid(),title,parent_id:id,work_status:'todo'})))})})
}
function mergeConcerns() {
  showDialog(t('Merge or group concerns','우려 사항 병합 또는 그룹 지정'),round().concerns.map(concern=>checkbox(`concern:${concern.id}`,concern.title)).join('')+selectField('operation',t('Operation','작업'),[['merge',t('Merge into one concern','하나로 병합')],['group',t('Keep concerns and set group','우려를 유지하고 그룹 지정')]],'merge')+field('title',t('Merged concern / group name','병합한 우려 / 그룹 이름')),async data=>{const ids=[...data.keys()].filter(key=>key.startsWith('concern:')).map(key=>key.slice(8));if(ids.length<2 || !data.get('title').trim())throw new Error(t('Select two concerns and enter a name.','두 개 이상의 우려 사항을 선택하고 이름을 입력하세요.'));await updateRound(r=>{if(data.get('operation')==='group')r.concerns.forEach(c=>{if(ids.includes(c.id))c.group=data.get('title')});else {const selected=r.concerns.filter(c=>ids.includes(c.id)),merged={...clone(selected[0]),id:uid(),title:data.get('title'),source_spans:selected.flatMap(c=>c.source_spans || []),comments:selected.flatMap(c=>c.comments || []),work_status:'todo'};r.concerns=r.concerns.filter(c=>!ids.includes(c.id));r.concerns.push(merged);r.mappings.forEach(map=>{if(ids.includes(map.concern_id)){map.concern_id=merged.id;map.stale=true;map.needs_reconfirmation=true;map.decision='proposed'}});selectedConcern=merged.id}})})
}
function createMapping() {
  const concern=round().concerns.find(item=>item.id===selectedConcern)
  if(!concern)throw new Error(t('Select a concern to connect.','연결할 우려 사항을 선택하세요.'))
  showDialog(t('Connect selected passages','선택한 구절 연결'),`<h3>${esc(concern.title)}</h3><p class="small muted">${responseSelections.length} ${t('response passage(s)','답변 구절')}</p>`+selectField('coverage',t('Coverage','답변 범위'),['addressed','partial','related','missing','uncertain'].map(value=>[value,statusText(value)]),'addressed')+field('reason',t('Reason','연결 이유'),'','textarea')+field('missing',t('Missing points (one per line)','누락한 내용 (줄마다 하나씩)'),'','textarea'),async data=>{if(!responseSelections.length && data.get('coverage')!=='missing')throw new Error(t('Add at least one response passage, or select Missing.','답변 구절을 추가하거나 누락 상태를 선택하세요.'));const mapping={id:uid(),concern_id:concern.id,response_spans:clone(responseSelections),coverage:data.get('coverage'),reason:data.get('reason'),missing:data.get('missing').split('\n').map(value=>value.trim()).filter(Boolean),origin:'manual',decision:'confirmed'};await updateRound(r=>{if(sourceSelections.length){const c=r.concerns.find(c=>c.id===concern.id);c.source_spans.push(...clone(sourceSelections))}r.mappings.push(mapping)});responseSelections=[];sourceSelections=[];renderAll()})
}
function mappingDetails(id) {
  const item=round().mappings.find(map=>map.id===id); if(!item)return
  showDialog(t('Connection details','연결 상세'),`<h3>${esc(round().concerns.find(c=>c.id===item.concern_id)?.title)}</h3><p>${badge(statusText(item.coverage))} ${badge(statusText(item.decision))}</p><p>${esc(item.reason)}</p>${item.response_spans.map(span=>`<blockquote>${esc(span.quote)}</blockquote>`).join('')}<h3>${t('Missing points','누락한 내용')}</h3><p>${esc(item.missing?.join('\n') || t('None recorded','기록 없음'))}</p>`,null)
}
function editItem(kind,id) {
  const key=kind==='evidence'?'evidence':'work_items', item=round()[key].find(item=>item.id===id)
  showDialog(kind==='evidence'?t('Evidence','근거'):t('Work item','작업'),field('title',t('Title','제목'),item?.title || '')+field('description',t('Description / verification notes','설명 / 검증 메모'),item?.description || '','textarea')+(kind==='evidence'?field('url',t('Source URL','출처 URL'),item?.url || '', 'url'):'')+`<div class="form-grid">${selectField('status',t('Status','상태'),['todo','review','done','blocked'].map(value=>[value,statusText(value)]),item?.status || 'todo')}${field('assignee',t('Assignee','담당자'),item?.assignee || '')}</div>`+selectField('concern_id',t('Linked concern','연결한 우려 사항'),[['',t('None','없음')],...round().concerns.map(c=>[c.id,c.title])],item?.concern_id || ''),async data=>{if(!data.get('title').trim())throw new Error(t('Enter a title.','제목을 입력하세요.'));const values={title:data.get('title'),description:data.get('description'),status:data.get('status'),assignee:data.get('assignee'),concern_id:data.get('concern_id') || null,...(kind==='evidence'?{url:data.get('url')}: {})};const next=item?{...item,...changedFormFields(data,values)}:{id:uid(),comments:[],...values};await updateRound(r=>{if(item)r[key]=r[key].map(i=>i.id===id?next:i);else r[key].push(next)})})
}
function commentItem(kind,id) {
  const key=kind==='evidence'?'evidence':'work_items'
  showDialog(t('Add comment','댓글 추가'),field('text',t('Comment','댓글'),'','textarea'),async data=>{if(!data.get('text').trim())throw new Error(t('Enter a comment.','댓글을 입력하세요.'));await updateRound(r=>{const item=r[key].find(item=>item.id===id);item.comments ||= [];item.comments.push({id:uid(),text:data.get('text'),author:session?.provider.awareness.getLocalState()?.user?.name || t('Author','작성자'),created_at:new Date().toISOString()})})})
}
function importReviews() {
  showDialog(t('Import reviews','리뷰 가져오기'),selectField('kind',t('Source','가져올 곳'),[['text',t('Paste text','텍스트 붙여넣기')],['json','JSON'],['pdf','PDF'],['openreview','OpenReview']],'text')+field('text',t('Review text / JSON','리뷰 텍스트 / JSON'),'','textarea')+`<label class="field">${t('File (text, JSON, PDF)','파일 (텍스트, JSON, PDF)')}<input type="file" name="file" accept=".txt,.md,.json,.pdf,text/plain,application/json,application/pdf"></label>`+field('forum',t('OpenReview forum ID or URL','OpenReview 포럼 ID 또는 URL'))+`<p class="form-help">${t('Imported content is staged first. Verify every review before confirming. Private forums require an OpenReview connection.','가져온 내용은 먼저 미리보기로 준비합니다. 리뷰 내용을 확인한 뒤 확정하세요. 비공개 포럼에는 OpenReview 연결이 필요합니다.')}</p>`,async data=>{
    let kind=data.get('kind'), text=data.get('text'), file=data.get('file'), payload={kind}
    if(file?.size){if(file.size>20*1024*1024)throw new Error(t('Choose a file smaller than 20 MB.','20MB 미만의 파일을 선택하세요.'));payload.filename=file.name;if(file.name.toLowerCase().endsWith('.pdf')){kind='pdf';payload.kind=kind;const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));payload.data_base64=btoa(binary)}else{text=await file.text();payload.kind=file.name.endsWith('.json')?'json':kind}}
    if(kind==='openreview'){payload.forum=data.get('forum');if(openreviewConnection)payload.connection_id=openreviewConnection;payload.api_version=2}else if(kind!=='pdf')payload.text=text
    const result=await mutate(`/rounds/${roundId}/imports`,payload)
    const staged=result.result?.import || result.import
    if(!staged)throw new Error(t('Import preview was not returned.','가져오기 미리보기를 받지 못했습니다.'))
    queueMicrotask(()=>previewImport(staged));return false
  },t('Prepare preview','미리보기 준비'))
}
function structureSummary(info) {
  return esc(t(`Official reviews ${info.official_review || 0} · AI reviews ${info.ai_review || 0} · Comments ${info.comment || 0}`,`공식 리뷰 ${info.official_review || 0}개 · AI 리뷰 ${info.ai_review || 0}개 · 공지 ${info.comment || 0}개`))
}
async function resumeImport(id) {
  const original = round().imports.find(item=>item.id===id)
  if (!original) throw new Error(t('Import not found','가져온 자료가 없습니다'))
  let staged = original
  if (['pdf','text'].includes(original.kind)) {
    const result = await mutate(`/rounds/${roundId}/imports/${id}/reparse`)
    staged = result.result.import
  }
  previewImport(staged)
}
function previewImport(staged) {
  const reviews=staged.reviews || []
  showDialog(t('Review import preview','가져올 리뷰 확인'),`<p class="muted small">${t('Edit extraction errors here. The original source will be retained. Nothing is added until you confirm.','추출 오류를 여기서 수정하세요. 원본은 보존됩니다. 확정하기 전에는 리뷰에 추가되지 않습니다.')}</p>${staged.structure ? `<p class="notice">${structureSummary(staged.structure)}<br>${t('Official reviews are selected by default. AI reviews and administrative comments are optional. Translation and concern analysis run only when you press their buttons.','사람의 공식 리뷰를 기본 선택합니다. AI 리뷰와 운영진 공지는 선택 사항입니다. 번역·쟁점 분석은 해당 버튼을 눌렀을 때 실행됩니다.')}</p>` : ''}${reviews.map((review,index)=>`<section class="preview-review">${review.source_type ? badge(review.source_type==='official_review'?t('Official review','공식 리뷰'):review.source_type==='ai_review'?t('AI review','AI 리뷰'):t('Comment','공지')) : ''}${field(`reviewer:${index}`,t('Reviewer name / ID','리뷰어 이름 / ID'),review.reviewer_id || review.reviewer || `Reviewer ${index+1}`)}${Object.entries(review.fields || {review:review.text || ''}).map(([key,value])=>field(`review:${index}:${key}`,key,value,'textarea')).join('')}${checkbox(`include:${index}`,t('Include this review','이 리뷰 포함'),review.suggested_include!==false)}</section>`).join('')}${staged.pages?.length?`<details><summary>${t('Extracted PDF pages','PDF 페이지별 추출')}</summary>${staged.pages.map(page=>`<h3>${t('Page','페이지')} ${page.page}</h3><pre class="export-preview">${esc(page.text)}</pre>`).join('')}</details>`:''}`,async data=>{const edited=reviews.map((review,index)=>({...review,reviewer_id:data.get(`reviewer:${index}`),fields:Object.fromEntries(Object.keys(review.fields || {review:''}).map(key=>[key,data.get(`review:${index}:${key}`)]))})).filter((_,index)=>data.has(`include:${index}`));if(!edited.length)throw new Error(t('Select at least one review.','리뷰를 하나 이상 선택하세요.'));await mutate(`/rounds/${roundId}/imports/${staged.id}/commit`,{reviews:edited});notice(t('Reviews imported; the source is preserved. Use Analyze reviews or Translate reviews in Reviews & responses to start AI processing.','리뷰를 가져왔으며 원본을 보존했습니다. ‘리뷰와 답변’의 ‘리뷰 분석’ 또는 ‘리뷰 번역’ 버튼으로 AI 처리를 시작하세요.'))},t('Confirm import','가져오기 확정'))
}
function openReviewSession() {
  if(openreviewConnection){showDialog(t('OpenReview connection','OpenReview 연결'),`<p>${t('Connected for this browser session. Credentials are held temporarily by the server.','이 브라우저 세션에 연결되어 있습니다. 인증 정보는 서버에서 일시적으로 보관합니다.')}</p>`,async()=>{await mutate('/openreview/session',{},'DELETE');openreviewConnection=null;notice(t('OpenReview disconnected.','OpenReview 연결을 해제했습니다.'))},t('Disconnect','연결 해제'));return}
  showDialog(t('Connect to OpenReview','OpenReview에 연결'),field('username',t('OpenReview email / username','OpenReview 이메일 / 사용자 이름'))+field('password',t('Password','비밀번호'),'','password')+`<p class="form-help">${t('The connection is temporary and stays in this browser session. Your OpenReview token is never returned to the editor.','연결은 이 브라우저 세션에 일시적으로 유지됩니다. OpenReview 토큰은 편집기로 전달되지 않습니다.')}</p>`,async data=>{const username=data.get('username'),password=data.get('password');$('dialog-form').querySelector('[name="password"]').value='';const result=await mutate('/openreview/session',{username,password,api_version:2});const connection=result.result || {};if(connection.mfa_required || connection.challenge_id){queueMicrotask(()=>mfaSession(connection));return false}openreviewConnection=connection.connection_id;notice(t('OpenReview connected.','OpenReview에 연결했습니다.'))},t('Connect','연결'))
}
function mfaSession(challenge) {
  const methods=challenge.methods || ['totp']
  showDialog(t('OpenReview verification','OpenReview 본인 확인'),selectField('method',t('Verification method','인증 방식'),methods.map(method=>typeof method==='string'?[method,method]:[method.id || method.method,method.name || method.id]),methods[0]?.id || methods[0])+field('code',t('Verification code','인증 코드'))+`<p class="form-help">${t('For email verification, leave the code empty and continue to request a code.','이메일 인증은 코드를 비운 채 계속하면 인증 코드를 요청합니다.')}</p>`,async data=>{const response=await mutate('/openreview/session/mfa',{challenge_id:challenge.challenge_id,method:data.get('method'),code:data.get('code')});if(response.result?.code_sent){notice(t('Verification code sent. Enter the code to continue.','인증 코드를 보냈습니다. 코드를 입력해 계속하세요.'));return false}openreviewConnection=response.result?.connection_id;notice(t('OpenReview connected.','OpenReview에 연결했습니다.'))},t('Continue','계속'))
}
function editReviewTranslations() {
  const entries=round().reviews.filter(review=>!currentReviewerId || review.reviewer_id===currentReviewerId).flatMap(review=>Object.entries(review.fields || {}).map(([name,original])=>({reviewId:review.id,name,original,value:review.translations?.[name] || ''})))
  showDialog(t('Edit Korean review translation','리뷰 한국어 번역 수정'),entries.map((item,index)=>`<h3>${esc(item.name)}</h3><blockquote>${esc(item.original)}</blockquote>`+field(`translation:${index}`,t('Korean','한국어'),item.value,'textarea')).join(''),async data=>{
    await updateRound(r=>{for(const [index,entry] of entries.entries()){if(data.get(`translation:${index}`)===entry.value)continue;const review=r.reviews.find(item=>item.id===entry.reviewId);if(!review)continue;review.translations ||= {};review.translations[entry.name]=data.get(`translation:${index}`)}})
  })
}
function editTranslation(value) {
  const separator=value.indexOf(':'), reviewId=value.slice(0,separator), name=value.slice(separator+1), review=round().reviews.find(item=>item.id===reviewId)
  showDialog(t('Edit Korean translation','한국어 번역 편집'),`<blockquote class="review-text">${esc(review.fields[name])}</blockquote>`+field('translation',t('Korean translation','한국어 번역'),review.translations?.[name] || '','textarea'),async data=>{await updateRound(r=>{if(!Object.hasOwn(changedFormFields(data,{translation:data.get('translation')}),'translation'))return;const item=r.reviews.find(item=>item.id===reviewId);item.translations ||= {};item.translations[name]=data.get('translation')})})
}
function editGlossary() {
  const entries=Object.entries(round().glossary || {})
  showDialog(t('Translation glossary','번역 용어집'),`<p class="form-help">${t('Use one original term = Korean translation per line. Translation actions use this glossary.','줄마다 원어 = 한국어 번역을 하나씩 입력하세요. 번역 작업에서 이 용어집을 사용합니다.')}</p>`+field('glossary',t('Terms','용어'),entries.map(([key,value])=>`${key} = ${typeof value==='string'?value:JSON.stringify(value)}`).join('\n'),'textarea'),async data=>{const glossary={};for(const line of data.get('glossary').split('\n').filter(line=>line.trim())){const index=line.indexOf('=');if(index<1)throw new Error(t('Each line needs an original term and a translation separated by =.','각 줄을 원어 = 번역 형식으로 입력하세요.'));glossary[line.slice(0,index).trim()]=line.slice(index+1).trim()}await updateRound(r=>{r.glossary=glossary})})
}
function limitFields(limit={},index=0) {
  const documents=round().documents
  return `<fieldset class="preview-review limit-config" data-limit="${index}"><legend>${t('Length limit','분량 제한')} ${index+1}</legend><div class="form-grid">${selectField(`limit:${index}:scope`,t('Scope','범위'),[['document',t('One document','문서 하나')],['total',t('All documents','전체 문서')],['target',t('Submission target','제출 대상')]],limit.scope || 'document')}${selectField(`limit:${index}:document_id`,t('Document','문서'),documents.map(doc=>[doc.id,doc.title]),limit.document_id || documents[0]?.id)}${selectField(`limit:${index}:unit`,t('Unit','단위'),[['characters',t('Characters','글자')],['words',t('Words','단어')],['pages',t('Pages (compiler)','페이지 (컴파일 결과)')]],limit.unit || 'characters')}${field(`limit:${index}:max`,t('Maximum (required)','최댓값 (필수)'),limit.max ?? '', 'number')}${selectField(`limit:${index}:basis`,t('Counting basis','계산 기준'),[['raw',t('Raw text','원문 텍스트')],['rendered',t('Rendered text','렌더링된 텍스트')]],limit.basis || 'raw')}${selectField(`limit:${index}:character_mode`,t('Character mode','글자 계산 방식'),[['codepoints',t('Unicode characters','유니코드 문자')],['utf16','UTF-16']],limit.character_mode || 'codepoints')}</div><div class="limit-options">${[['count_spaces',t('Spaces','공백')],['count_newlines',t('Newlines','줄바꿈')],['include_headings',t('Headings','제목')],['include_quotes',t('Quotes','인용')],['include_math',t('Math','수식')],['include_references',t('References','참고문헌')]].map(([key,label])=>`<label><input type="checkbox" name="limit:${index}:${key}" ${limit[key]!==false?'checked':''}>${label}</label>`).join('')}</div><button type="button" data-action="remove-limit" class="danger">${t('Remove limit','제한 삭제')}</button></fieldset>`
}
function editRules(candidate) {
  const current=candidate && typeof candidate==='object'?candidate:round().rules.find(rule=>rule.id===round().active_rules_id) || {}, limits=current.limits || []
  showDialog(t('Create rules draft','규정 초안 작성'),`<div class="form-grid">${field('venue',t('Venue','학회'),current.venue || '')}${field('year',t('Year','연도'),current.year || new Date().getFullYear(),'number')}${field('track',t('Track','트랙'),current.track || '')}${field('stage',t('Stage','단계'),current.stage || 'rebuttal')}${selectField('layout',t('Response layout','답변 구성'),[['per_reviewer',t('Per reviewer','리뷰어별')],['unified',t('Unified','통합')],['threads',t('Threads','스레드별')]],current.layout || 'per_reviewer')}${field('deadline',t('Deadline (ISO date/time)','마감 (ISO 날짜/시간)'),current.deadline?.at || '')}${field('timezone',t('Deadline time zone','마감 시간대'),current.deadline?.timezone || 'UTC')}</div>${checkbox('allow_common',t('Allow a common response','공통 답변 허용'),current.allow_common!==false,{switchControl:true})}<h3>${t('Length limits','분량 제한')}</h3><p class="form-help">${t('Leave the list empty when the venue has no verified limit.','확인된 제한이 없으면 목록을 비워 두세요.')}</p><div id="limits-editor">${limits.map(limitFields).join('')}</div><button type="button" data-action="add-limit">${t('＋ Add limit','＋ 제한 추가')}</button>${field('sources',t('Official source URLs (one per line)','공식 출처 URL (줄마다 하나씩)'),(current.sources || []).map(source=>source.url).filter(Boolean).join('\n'),'textarea')}${field('policies',t('Policies (JSON object)','정책 (JSON 객체)'),JSON.stringify(current.policies || {},null,2),'textarea')}${field('notes',t('Notes','메모'),current.notes || '','textarea')}<p class="form-help">${t('Saving creates a draft. Review the diff and explicitly apply it from Overview.','저장하면 초안을 만듭니다. 개요에서 변경 내역을 검토한 뒤 직접 적용하세요.')}</p>`,async data=>{
    const limits=[]
    for(const fieldset of $('dialog-body').querySelectorAll('.limit-config')){const i=fieldset.dataset.limit,limit={id:uid()};for(const key of ['scope','document_id','unit','basis','character_mode'])limit[key]=data.get(`limit:${i}:${key}`);const raw=data.get(`limit:${i}:max`);if(raw==='' || !Number.isFinite(Number(raw)) || Number(raw)<=0)throw new Error(t('Every limit needs a positive maximum.','각 제한에 양수 최댓값을 입력하세요.'));limit.max=Number(raw);for(const key of ['count_spaces','count_newlines','include_headings','include_quotes','include_math','include_references'])limit[key]=data.has(`limit:${i}:${key}`);if(limit.scope!=='document')delete limit.document_id;limits.push(limit)}
    let policies;try{policies=JSON.parse(data.get('policies') || '{}')}catch{throw new Error(t('Policies must be a JSON object.','정책을 JSON 객체로 입력하세요.'))}if(!policies || Array.isArray(policies) || typeof policies!=='object')throw new Error(t('Policies must be a JSON object.','정책을 JSON 객체로 입력하세요.'))
    const sources=data.get('sources').split('\n').map(url=>url.trim()).filter(Boolean).map(url=>{if(!/^https?:\/\//.test(url))throw new Error(t('Use valid HTTP(S) source URLs.','올바른 HTTP(S) 출처 URL을 입력하세요.'));return current.sources?.find(source=>source.url===url) || {url,status:'unverified'}})
    await mutate(`/rounds/${roundId}/rules`,{rules:{venue:data.get('venue'),year:Number(data.get('year')),track:data.get('track'),stage:data.get('stage'),layout:data.get('layout'),allow_common:data.has('allow_common'),limits,policies,sources,notes:data.get('notes'),...(data.get('deadline')?{deadline:{at:data.get('deadline'),timezone:data.get('timezone')}}:{})}});screen='overview';renderAll();notice(t('Rules saved as a draft. Review and apply this version to activate its limits.','규정을 초안으로 저장했습니다. 검토 후 이 버전을 적용하면 제한이 활성화됩니다.'))
  },t('Save draft','초안 저장'))
}
async function runAnalysis(task) {
  if(task==='translate'){await translateSelectedReviewer();return}
  if(task==='research_rules'){
    const current=round().rules.find(rule=>rule.id===round().active_rules_id) || {}
    showDialog(taskText(task),field('venue',t('Venue','학회'),current.venue || '')+field('year',t('Year','연도'),current.year || new Date().getFullYear(),'number')+field('track',t('Track','트랙'),current.track || '')+field('stage',t('Stage','단계'),current.stage || 'rebuttal')+field('urls',t('Official source URLs','공식 출처 URL'),(current.sources || []).map(source=>source.url).filter(Boolean).join('\n'),'textarea')+`<p class="form-help">${t('Research uses public official sources. Results remain a draft until explicitly applied.','공개된 공식 출처를 조사합니다. 결과는 직접 적용하기 전까지 초안으로 유지됩니다.')}</p>`,async data=>{await queueAnalysis(task,{research:{venue:data.get('venue'),year:Number(data.get('year')),track:data.get('track'),stage:data.get('stage'),sources:data.get('urls').split('\n').filter(Boolean).map(url=>({url}))}})},t('Start research','조사 시작'));return
  }
  let selection
  if(task==='rewrite') {if(!editor || editor.getSelection().start===editor.getSelection().end)throw new Error(t('Select the response passage you want to rewrite.','다시 작성할 답변 구절을 선택하세요.'));const {start,end}=editor.getSelection();selection={document_id:currentDocId,start,end,quote:editor.getValue().slice(start,end)}}
  if(task==='analyze') {
    const reviewIds=round().reviews.filter(review=>review.reviewer_id===currentReviewerId).map(review=>review.id)
    if(!reviewIds.length)throw new Error(t('Select a reviewer with an imported review.','가져온 리뷰가 있는 리뷰어를 선택하세요.'))
    const documentIds=round().documents.filter(doc=>doc.reviewer_id===currentReviewerId || ['common','unified'].includes(doc.kind)).map(doc=>doc.id)
    await queueAnalysis(task,{scope:{review_ids:reviewIds,document_ids:documentIds}});return
  }
  await queueAnalysis(task,selection?{selection}:{})
}
async function translateSelectedReviewer(){
  const reviewIds=round().reviews.filter(review=>review.reviewer_id===currentReviewerId).map(review=>review.id)
  if(!reviewIds.length)throw new Error(t('Select a reviewer with an imported review.','가져온 리뷰가 있는 리뷰어를 선택하세요.'))
  await queueAnalysis('translate',{scope:{review_ids:reviewIds,document_ids:[]}})
}
async function checkResponse() {
  if(checkSubmitting || state.jobs.some(job=>job.round_id===roundId && ['queued','running'].includes(job.status)))return
  const reviewIds=round().reviews.filter(review=>review.reviewer_id===currentReviewerId).map(review=>review.id)
  const doc=documentFor()
  if(!reviewIds.length || !doc || (doc.kind==='reviewer' && doc.reviewer_id!==currentReviewerId))throw new Error(t('Select a reviewer and their response before finding connections.','연결을 확인할 리뷰어와 해당 답변을 먼저 선택하세요.'))
  setConnectionVisibility(true)
  checkSubmitting=true
  const existingJobs=new Set(state.jobs.map(job=>job.id))
  renderAll()
  try {
    const id=roundId
    await flushResponseRevisions()
    if(roundId!==id || documentFor()?.id!==doc.id)return
    const result=await mutate(`/rounds/${id}/analyses`,{task:'connect',texts:liveTextsFor(),scope:{review_ids:reviewIds,document_ids:[doc.id]}})
    checkJobId=result.result?.job?.id ?? state.jobs.find(job=>!existingJobs.has(job.id) && job.round_id===id)?.id
    schedulePoll(2000)
  } finally {checkSubmitting=false;renderAll()}
}
async function startResponse() {
  if(!currentReviewerId)return
  const reviewer=currentReviewerId
  await mutate(`/rounds/${roundId}/documents`,{title:`${t('Response to','답변:')} ${reviewerName(reviewer)}`,kind:'reviewer',reviewer_id:reviewer})
  selectReviewer(reviewer);renderAll();editor?.focus()
}
async function queueAnalysis(task,extra={}) {
  const id=roundId
  await flushResponseRevisions()
  if(roundId!==id)return
  await mutate(`/rounds/${id}/analyses`,{task,texts:liveTextsFor(),...(selectedConcern?{scope:{concern_ids:[selectedConcern]}}:{}),...extra})
  schedulePoll(2000)
}
function reviewRewrite(jobId) {
  const job=state.jobs.find(item=>item.id===jobId), result=job?.result, selection=job?.input_snapshot?.selection || job?.snapshot?.selection || job?.selection
  if(!result?.replacement)throw new Error(t('This job has no replacement text.','이 작업에 교체할 본문이 없습니다.'))
  showDialog(t('Review rewrite','재작성 검토'),`<h3>${t('Before','이전')}</h3><pre class="export-preview diff-before">${esc(selection?.quote || '')}</pre><h3>${t('Proposed replacement','교체 제안')}</h3><pre class="export-preview diff-after">${esc(result.replacement)}</pre><p>${esc(result.summary || '')}</p>`,async()=>{if(!selection?.document_id)throw new Error(t('The original selection is unavailable. Copy the suggestion after reviewing it.','원래 선택 영역을 확인할 수 없습니다. 제안을 검토한 뒤 복사하세요.'));const text=texts()[selection.document_id];const hashes=await textHashes(text);if(job.text_hashes?.[selection.document_id] && !hashes.includes(job.text_hashes[selection.document_id]) || texts()[selection.document_id]!==text)throw new Error(t('The response changed since this rewrite was requested. Select the passage and run rewrite again.','재작성 요청 후 답변이 바뀌었습니다. 구절을 선택해 다시 재작성하세요.'));const span=verifiedSpan(selection,text,resolveResponseRange);if(!span)throw new Error(t('The original text changed. Run rewrite on a fresh selection.','원문이 바뀌었습니다. 새 선택 영역으로 재작성하세요.'));const doc=round().documents.find(doc=>doc.id===selection.document_id);replaceSharedText(sharedTexts.get(doc.text_key || doc.id),text.slice(0,span.start)+result.replacement+text.slice(span.end),localOrigin);if(doc.id===currentDocId)editor?.setValue(texts()[doc.id]);markStale(doc.id)},t('Apply replacement','교체 적용'))
}
function applyFinding(id) {
  const finding=round().findings.find(item=>item.id===id), value=texts()[finding.document_id] || ''
  showDialog(t('Review wording change','표현 변경 검토'),`<p>${esc(finding.reason)}</p><h3>${t('Before','이전')}</h3><pre class="export-preview diff-before">${esc(finding.quote)}</pre><h3>${t('After','이후')}</h3><pre class="export-preview diff-after">${esc(finding.suggestion)}</pre>${finding.meaning_change?`<p>${badge(t('This may change the meaning. Verify the claim before applying.','의미가 바뀔 수 있습니다. 적용 전에 주장을 확인하세요.'),'warn')}</p>`:''}`,async()=>{const current=texts()[finding.document_id] || '';const job=state.jobs.find(job=>job.input_hash===finding.input_hash),hashes=await textHash(current);if(job?.text_hashes?.[finding.document_id] && hashes!==job.text_hashes[finding.document_id] || texts()[finding.document_id]!==current)throw new Error(t('The response changed. Run a new check.','답변이 바뀌었습니다. 다시 점검하세요.'));if(current!==value || finding.stale || finding.status==='stale')throw new Error(t('The response changed. Run a new check before applying.','답변이 바뀌었습니다. 다시 점검한 후 적용하세요.'));const start=current.indexOf(finding.quote);if(start<0 || current.indexOf(finding.quote,start+1)>=0)throw new Error(t('The quoted passage is missing or ambiguous. Apply this change manually.','인용 구절을 정확히 특정할 수 없습니다. 직접 수정하세요.'));const doc=round().documents.find(doc=>doc.id===finding.document_id),shared=sharedTexts.get(doc.text_key || doc.id);replaceSharedText(shared,current.slice(0,start)+finding.suggestion+current.slice(start+finding.quote.length),localOrigin);if(doc.id===currentDocId)editor?.setValue(shared.toString());await updateRound(r=>{const item=r.findings.find(item=>item.id===id);item.status='applied'})},t('Apply change','변경 적용'))
}
const {
  koreanSource, koreanGlossary, koreanGlossaryMatches, koreanDisplayValue, koreanKey, koreanMeta,
  koreanText, restoreKoreanMetadata, koreanProgress, koreanTranslating, renderKoreanStatus,
  mountKorean, requestKoreanTranslation, scheduleKoreanRefresh
} = createKoreanTranslation({
  $, t, documentFor, sharedTexts, sessionBindings, readOnly, localOrigin, clone, guard, notice,
  refresh, mutate, request, liveTexts:()=>liveTextsFor(), flushResponseRevisions,
  getSession:()=>session, isSessionReady:()=>sessionReady, getRoundId:()=>roundId,
  getRounds:()=>state.rounds, getAnswerLanguage:()=>answerLanguage, isPreview:()=>responsePreview,
  isReviewVisible:()=>reviewViewVisible && screen==='reviews', renderKoreanConnections,
  koreanConnectionRanges, updateResponsePreview, scheduleEdges, restoreLanguagePosition
})
const {liveTextsFor, updateMechanical, renderSubmission, exportResponses, viewSubmission} = createSubmission({
  $, t, esc, clone, round, documentFor, texts, sharedTexts, readOnly, badge, action, field,
  selectField, guard, showDialog, mutate, notice, koreanText, koreanMeta, koreanGlossary,
  koreanGlossaryMatches, flushResponseRevisions, getSession:()=>session, isSessionReady:()=>sessionReady,
  getLanguage:()=>language, getTargetIds:()=>targetIds, getCommonMode:()=>commonMode, setCommonMode:value=>{commonMode=value}
})
const actions = {
  'new-round':newRound,'new-document':newDocument,import:importReviews,'resume-import':resumeImport,'openreview-session':openReviewSession,glossary:editGlossary,rules:editRules,
  'capture-source':captureSource,'capture-response':captureResponse,'new-concern':()=>editConcern(),'edit-concern':editConcern,'split-concern':splitConcern,'merge-concerns':mergeConcerns,'create-mapping':createMapping,'mapping-details':mappingDetails,
  'clear-source':()=>{sourceSelections=[];renderSelections()},'clear-response':()=>{responseSelections=[];renderSelections()},
  'select-concern':id=>{const deselect=selectedConcern===id;selectedConcern=deselect?null:id;dismissedHoverConcern=deselect?id:null;renderReviewsKeepingScroll()},
  'toggle-connection-details':()=>{connectionDetailsCollapsed=!connectionDetailsCollapsed;window.PaperPreferenceStorage?.set('paper-rebuttal-connection-details-collapsed',String(connectionDetailsCollapsed));syncConnectionDetailsCollapse()},
  'confirm-mapping':id=>{const mapping=round().mappings.find(map=>map.id===id);const spans=mapping.response_spans.map(span=>verifiedSpan(span,texts()[span.document_id] || '',resolveResponseRange));if(spans.some(span=>!span))throw new Error(t('A linked passage changed. Select the updated passage and make a new connection.','연결한 구절이 바뀌었습니다. 최신 구절을 선택해 새로 연결하세요.'));return updateRound(r=>{const item=r.mappings.find(map=>map.id===id);item.response_spans=spans;item.decision='confirmed';item.stale=false;item.reconfirm=true;item.origin=item.origin || 'manual'})},
  'reject-mapping':id=>updateRound(r=>{r.mappings.find(map=>map.id===id).decision='rejected'}),
  'focus-span':async(id,element)=>{const mapping=round().mappings.find(map=>map.id===id),span=mapping.response_spans.find(span=>span.document_id===element.dataset.document);currentDocId=span.document_id;if(answerLanguage==='ko'){renderReviews();await mountKorean();await new Promise(resolve=>requestAnimationFrame(resolve));const root=responsePreview?$('response-preview'):$('response-korean');const mark=[...(root?.querySelectorAll('.rebuttal-span') || [])].find(node=>node.dataset.mappingId===id);if(mark){mark.scrollIntoView({block:'center'});mark.focus()}else notice(t('The Korean translation could not be aligned to this passage.','이 구절의 한국어 번역 위치를 확인할 수 없습니다.'),true);return}responsePreview=false;renderReviews();const verified=verifiedResponseSpan(span,editor.getValue());if(verified){editor.setSelection(verified.start,verified.end,{scroll:true});editor.focus()}else notice(t('This passage changed. Reconfirm its connection.','구절이 바뀌었습니다. 연결을 다시 확인하세요.'),true)},
  'open-review':id=>{selectReviewer(id);screen='reviews';navigate()},'reviewer-mate-click':id=>{if(document.body.classList.contains('is-sidebar-collapsed') && (screen!=='reviews' || currentReviewerId!==id)){selectReviewer(id);screen='reviews';navigate()}else changeReviewerMate(id)},'open-document':id=>{currentDocId=id;currentReviewerId=documentFor()?.reviewer_id || currentReviewerId;selectedConcern=null;sourceSelections=[];responseSelections=[];screen='reviews';navigate()},
  'check-response':checkResponse,'start-response':startResponse,'response-history':responseHistory,
  'retry-response-texts':()=>{textBindingError=null;renderAll();return bindTexts()},
  'new-evidence':()=>editItem('evidence'),'edit-evidence':id=>editItem('evidence',id),'comment-evidence':id=>commentItem('evidence',id),
  'new-work':()=>editItem('work'),'edit-work':id=>editItem('work',id),'comment-work':id=>commentItem('work',id),
  'translate-response-ko':requestKoreanTranslation,'edit-translation':editTranslation,'edit-review-translations':editReviewTranslations,'translate-reviews':translateSelectedReviewer,analysis:runAnalysis,
  'cancel-job':id=>mutate(`/rounds/${roundId}/analyses/${id}/cancel`),'retry-job':async id=>{const rid=roundId;await flushResponseRevisions();return mutate(`/rounds/${rid}/analyses/${id}/retry`)},
  'review-rewrite':reviewRewrite,'view-job':id=>{const job=state.jobs.find(item=>item.id===id);showDialog(t('Analysis result','분석 결과'),`<pre class="export-preview">${esc(JSON.stringify(job.result,null,2))}</pre>`,null)},
  'apply-finding':applyFinding,'reject-finding':id=>updateRound(r=>{r.findings.find(item=>item.id===id).status='rejected'}),
  'archive-export':archiveExport,'review-rule-candidates':reviewRuleCandidates,'candidate-rules':value=>{const index=value.lastIndexOf(':');editRules(state.jobs.find(job=>job.id===value.slice(0,index)).result.rules_candidates[Number(value.slice(index+1))])},
  'apply-rules':id=>mutate(`/rounds/${roundId}/rules/${id}/apply`),
  'add-limit':()=>{const host=$('limits-editor'),indices=[...host.querySelectorAll('[data-limit]')].map(el=>Number(el.dataset.limit));host.insertAdjacentHTML('beforeend',limitFields({},Math.max(-1,...indices)+1))},
  'remove-limit':(_,element)=>element.closest('.limit-config').remove(),export:exportResponses,'view-submission':viewSubmission,refresh:()=>refresh(),
  backup:()=>backupAction('snapshot'),'backup-restore':()=>backupAction('restore')
}
function navigate() { location.hash=screen;renderAll() }
document.addEventListener('focusin',event=>{if(event.target.closest?.('#response-editor'))syncReviewPresence()})
document.addEventListener('focusout',event=>{if(event.target.closest?.('#response-editor'))queueMicrotask(syncReviewPresence)})
document.addEventListener('click',event=>{
  const fieldToggle=event.target.closest('.review-field-toggle');if(fieldToggle){const section=fieldToggle.closest('.review-field'),body=section.querySelector('.review-field-body'),key=JSON.stringify([roundId,section.dataset.reviewId,section.dataset.reviewField]),collapsed=fieldToggle.getAttribute('aria-expanded')==='true';if(collapsed)collapsedReviewFields.add(key);else collapsedReviewFields.delete(key);saveCollapsedReviewFields();section.dataset.collapsed=String(collapsed);fieldToggle.setAttribute('aria-expanded',String(!collapsed));body.setAttribute('aria-hidden',String(collapsed));body.inert=collapsed;updateHighlights();scheduleEdges();return}
  const answerTab=event.target.closest('[data-answer-language]');if(answerTab){
    changeAnswerLanguage(answerTab.dataset.answerLanguage);return
  }
  const responseView=event.target.closest('[data-response-view]');if(responseView){setResponsePreview(!responsePreview,{preservePosition:true});return}
  const reviewLanguage=event.target.closest('[data-review-language]');if(reviewLanguage){koreanReview=reviewLanguage.dataset.reviewLanguage==='ko';window.PaperPreferenceStorage?.set(reviewLanguageKey,koreanReview?'ko':'original');sourceSelections=[];renderAll();document.querySelector(`[data-review-language="${koreanReview?'ko':'original'}"]`)?.focus();return}
  const screenButton=event.target.closest('[data-screen]');if(screenButton){screen=screenButton.dataset.screen;navigate();return}
  const answerHighlight=event.target.closest('.rebuttal-span[data-concern-id]');if(answerHighlight && !answerHighlight.closest('#response-editor') && window.getSelection()?.isCollapsed){actions['select-concern'](answerHighlight.dataset.concernId);return}
  const button=event.target.closest('[data-action]');if(button && !button.disabled && actions[button.dataset.action])guard(()=>actions[button.dataset.action](button.dataset.id,button))
})
document.addEventListener('transitionrun',event=>{if(event.propertyName==='grid-template-rows' && event.target.matches('.review-field-body')){movingReviewFields.add(event.target);if(!reviewFieldEdgeFrame)reviewFieldEdgeFrame=requestAnimationFrame(animateReviewFieldEdges)}})
for(const type of ['transitionend','transitioncancel'])document.addEventListener(type,event=>{if(event.propertyName==='grid-template-rows' && event.target.matches('.review-field-body')){movingReviewFields.delete(event.target);scheduleEdges()}})
document.addEventListener('pointerover',event=>{const target=connectionTarget(event.target);if(target){clearTimeout(pointerFocusTimer);if(pointerConnection?.key!==target.key){if(dismissedHoverConcern && dismissedHoverConcern!==target.concernId)dismissedHoverConcern=null;pointerConnection=target;updateConnectionFocus();if(dismissedHoverConcern!==target.concernId)showHoveredConnectionDetails(target.concernId)}}})
document.addEventListener('pointerout',event=>{const target=connectionTarget(event.target);if(target && target.key!==connectionTarget(event.relatedTarget)?.key && pointerConnection?.key===target.key){if(event.target.isConnected && dismissedHoverConcern===target.concernId)dismissedHoverConcern=null;clearTimeout(pointerFocusTimer);pointerFocusTimer=setTimeout(()=>{if(pointerConnection?.key===target.key){pointerConnection=null;updateConnectionFocus()}},300)}})
document.addEventListener('focusin',event=>{const id=connectionTarget(event.target);if(id){keyboardConnection=id;updateConnectionFocus()}})
document.addEventListener('focusout',event=>{const target=connectionTarget(event.target);if(target && target.key!==connectionTarget(event.relatedTarget)?.key && keyboardConnection?.key===target.key){keyboardConnection=null;updateConnectionFocus()}})
document.addEventListener('selectionchange',()=>{const selection=window.getSelection();if(!selection?.rangeCount || selection.isCollapsed)return;const range=selection.getRangeAt(0),root=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement)?.closest('.review-text');if(root && $('review-content')?.contains(root) && root.contains(range.endContainer))savedReviewRange=range.cloneRange()})
document.addEventListener('pointerdown',event=>{if(event.target.closest('#review-content'))savedReviewRange=null})
document.addEventListener('keydown',event=>{const target=event.target.closest('[role="button"][data-action]');if(target && ['Enter',' '].includes(event.key)){event.preventDefault();target.click()}})

document.addEventListener('change',event=>{
  if(event.target.id==='show-all-connections'){
    setConnectionVisibility(event.target.checked)
    for(const mark of document.querySelectorAll('#review-content mark[data-action="select-concern"]')) mark.classList.toggle('is-active',showAllConnections || selectedConcern===mark.dataset.id)
    updateHighlights();if(responsePreview)updateResponsePreview();scheduleEdges()
  }
  if(event.target.matches('[data-target]')){targetIds=[...document.querySelectorAll('[data-target]:checked')].map(input=>input.dataset.target);updateMechanical()}
})

$('new-round').onclick=()=>guard(newRound)
$('round-select').onchange=event=>{roundId=event.target.value;currentDocId=null;selectedConcern=null;sourceSelections=[];responseSelections=[];targetIds=null;updateRoundURL(true);adopt(state)}
$('dialog-close').onclick=closeDialog;$('dialog-cancel').onclick=closeDialog
$('form-dialog').addEventListener('close',()=>{if(answerLanguage==='ko' && documentFor())scheduleKoreanRefresh(documentFor())})
$('dialog-form').onsubmit=async event=>{
  event.preventDefault();if(!dialogSubmit)return
  $('dialog-error').hidden=true;$('dialog-save').disabled=true
  try { const result=await dialogSubmit(new FormData(event.target));if(result!==false)closeDialog() }
  catch(error){$('dialog-error').textContent=error.message;$('dialog-error').hidden=false}
  finally{$('dialog-save').disabled=false}
}
window.addEventListener('hashchange',()=>{const value=location.hash.slice(1);if(['overview','reviews','evidence','submission'].includes(value) && value!==screen){screen=value;renderAll()}})
document.addEventListener('pointerdown',event=>{
  const handle=event.target.closest('.connection-details-resizer')
  if(!handle || event.button!==0)return
  event.preventDefault()
  const panel=handle.closest('.source-panel')
  panel.classList.add('is-resizing-connection-details')
  handle.setPointerCapture(event.pointerId)
  const move=event=>{const rect=panel.getBoundingClientRect();if(rect.height)setConnectionDetailsHeight((rect.bottom-event.clientY)/rect.height)}
  const finish=()=>{panel.classList.remove('is-resizing-connection-details');handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish);handle.removeEventListener('lostpointercapture',finish)}
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('lostpointercapture',finish)
})
document.addEventListener('keydown',event=>{
  if(!event.target.matches('.connection-details-resizer') || !['ArrowUp','ArrowDown','Home','End'].includes(event.key))return
  event.preventDefault()
  setConnectionDetailsHeight(event.key==='Home'?0.15:event.key==='End'?0.75:connectionDetailsHeight+(event.key==='ArrowUp'?0.05:-0.05))
})
window.addEventListener('resize',()=>{scheduleEdges();comments.refreshMarkers()})
function applyLanguage(value,{persist=false}={}) {
  if(!['en','ko'].includes(value))return
  language=value;$('language').value=value
  document.documentElement.lang=value;document.documentElement.dataset.language=value
  if(persist)window.PaperPreferenceStorage.set('paper-workspace-language',value)
  const url=new URL(location.href);url.searchParams.set('lang',value);history.replaceState(history.state,'',url)
  renderAll();window.dispatchEvent(new CustomEvent('paper-language-change',{detail:{language:value}}))
}
$('language').value=language
$('language').onchange=event=>applyLanguage(event.target.value,{persist:true})
window.addEventListener('storage',event=>{
  if(event.key==='paper-workspace-layout' && event.newValue){applyReviewSidebar();syncReviewerSidebarControls()}
  if(event.key==='paper-workspace-language' && event.newValue!==language)applyLanguage(event.newValue)
})
profileActor={id:window.PaperSidebarProfile.identity(),name:window.PaperPreferenceStorage.get('collab-name') || t('Author','작성자'),color:window.PaperPreferenceStorage.get('collab-color') || '#2457d6'}
window.PaperSidebarProfile.create({actor:profileActor,onChange:actor=>session?.updateActor(actor)})

function schedulePoll(delay) {
  clearTimeout(polling)
  if(!sessionBindings.closed)polling=setTimeout(poll,delay || (hasActiveAnalysis()?2000:5000))
}
function onlyTranslationActivityChanged(next) {
  if(screen!=='reviews' || next.enabled!==state.enabled)return false
  const metadata=value=>value.rounds.map(({analyses,...round})=>round)
  const otherJobs=value=>(value.jobs || []).filter(job=>!['translate','translate_response'].includes(job.task))
  return JSON.stringify(metadata(next))===JSON.stringify(metadata(state)) && JSON.stringify(otherJobs(next))===JSON.stringify(otherJobs(state))
}
async function poll() {
  try {
    if(!busy && !document.hidden && !sessionBindings.closed){
      await flushResponseRevisions()
      if(busy)return
      const next=await request('/state')
      if(pendingStale.size || responseRevisions.flushing || busy)return
      // Rejected replies must not affect editor locks or deferred form rendering.
      if(canAdopt(next)){
        const changed=next.revision!==state.revision || JSON.stringify(next.jobs)!==JSON.stringify(state.jobs)
        if(changed){
          const focused=editor?.focusWithin() || $('form-dialog').open
          const checkChanged=responseCheckRunning(state.jobs)!==responseCheckRunning(next.jobs)
          if(onlyTranslationActivityChanged(next)){
            adopt(next,false)
            if(answerLanguage==='ko' && documentFor())renderKoreanStatus(documentFor())
          }else if(focused && (!checkChanged || $('form-dialog').open)){
            adopt(next,false);metadataDirty=true;updateMechanical()
          }else{adopt(next);metadataDirty=false}
        }else adoptedSequence=responseSequences.get(next) ?? adoptedSequence
      }
    }
  }catch { /* Keep the current draft visible and retry on the next poll. */ }
  finally {if(!sessionBindings.closed)schedulePoll()}
}
async function backupAction(method) {
  if(!window.PaperRebuttalBackup)throw new Error(t('Backup is unavailable.','백업을 사용할 수 없습니다.'))
  const adapter=window.PaperRebuttalBackup.create({projectSlug:slug,session})
  if(method==='restore')showDialog(t('Restore rebuttal backup','Rebuttal 백업 복원'),field('snapshot',t('Snapshot JSON','스냅샷 JSON'),'','textarea'),async data=>{const snapshot=JSON.parse(data.get('snapshot'));await adapter.restore(snapshot);await refresh()},t('Restore as new rounds','새 라운드로 복원'))
  else {liveTextsFor();for(const r of state.rounds)if(r!==round())liveTextsFor(r);await adapter.refresh();const snapshot=adapter.snapshot();if(!snapshot)throw new Error(t('No backup data available.','백업 데이터가 없습니다.'));download({filename:`${slug}-rebuttal-backup.json`,mime:'application/json',content:JSON.stringify(snapshot,null,2)})}
}
async function start() {
  const actor=profileActor
  if(!window.PaperCollab?.createSession || !window.PaperEditor?.createEditor)throw new Error(t('The editor could not load. Reload this page.','편집기를 불러오지 못했습니다. 페이지를 새로고침하세요.'))
  const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window
  const shared = embedded && window.parent.PaperWorkspaceSharedSession
  session = shared || window.PaperCollab.createSession({url:`${location.protocol==='https:'?'wss':'ws'}://${location.host}/collab`,room:`paper-workspace:${location.host}:${slug}`,actor,onStatus(status){connectionStatus=status;renderSyncStatus()}})
  sessionBindings.on(session.provider?.awareness,'change',renderReviewPresence)
  sessionBindings.on(session.provider,'status',renderReviewPresence)
  sessionBindings.on(session.provider,'sync', synced=>{if(synced && sessionReady){bindTexts();for(const r of state.rounds)for(const doc of r.documents)scheduleResponseVersion(r.id,doc)}})
  const versionsInterval=setInterval(()=>{if(collaborationSynced() && !readOnly)for(const r of state.rounds)for(const doc of r.documents){const value=sharedTexts.get(doc.text_key || doc.id)?.toString();if(typeof value==='string')saveResponseVersion(r.id,doc,value).catch(error=>notice(t('Could not save response history: ','답변 버전 저장 실패: ')+error.message,true))}},60000)
  if(shared){const update=()=>{connectionStatus=shared.provider?.synced?'synced':shared.provider?.wsconnected?'connecting':'disconnected';renderSyncStatus()};sessionBindings.on(shared.provider,'status',update);sessionBindings.on(shared.provider,'sync',update);update();$('manuscript-link').addEventListener('click',event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();window.parent.PaperWorkspaceShowManuscript?.(window)}})}
  window.PaperRebuttalSession=session
  sessionBindings.observe(session.mapFor('rebuttalKoreanMeta'),()=>{if(answerLanguage==='ko' && documentFor())renderKoreanStatus(documentFor())})
  sessionBindings.observe(session.mapFor('rebuttalReviewerMates'),()=>{
    if(!round())return
    const mates=reviewerMates(reviewerIds())
    for(const button of document.querySelectorAll('#reviewer-nav [data-action="reviewer-mate-click"]')) {
      const avatar=button.querySelector('.reviewer-mate'), index=mates.get(button.dataset.id)
      if(avatar && index!==undefined)avatar.src=reviewerMateAssets[index]
    }
  })
  window.PaperRebuttal={session,slug,get projectId(){return slug},getTexts:texts,getState:()=>state,getSelection:()=>editor?.getSelection(),describePeer:peerLocation,followPeer:followProjectPeer,refresh,async restoreTexts(restored){
    await session.whenReady
    await session.ensureNamespacedTexts('rebuttalResponses',Object.entries(restored).map(([key,initial])=>({key,initial})))
    await refresh();await bindTexts()
  }}
  sessionBindings.observe(session.mapFor('rebuttalResponses'),()=>{if(sessionReady)bindTexts()})
  sessionBindings.observe(session.mapFor('rebuttalSourceStatus'),()=>{renderResponseSourceStatus();renderSyncStatus()})
  sessionBindings.add(()=>{
    comments.destroy()
    editor?.destroy?.()
    clearTimeout(polling)
    clearTimeout(presenceTimer)
    clearInterval(versionsInterval)
    for(const timer of responseVersionTimers.values())clearTimeout(timer)
  })
  const sharedReady=session.whenReady.then(async()=>{if(sessionBindings.closed)return;sessionReady=true;await bindTexts();if(sessionBindings.closed)return;reconcileFreshness();for(const r of state.rounds)for(const doc of r.documents)scheduleResponseVersion(r.id,doc)})
  await refresh()
  if(sessionBindings.closed)return
  renderAll();restoreNavigationContext();schedulePoll()
  if (shared) window.parent.PaperWorkspaceReviewReady?.(window)
  await sharedReady
  if(sessionBindings.closed)return
  renderAll();restoreNavigationContext()
  document.addEventListener('focusout',()=>{if(metadataDirty && !$('form-dialog').open)setTimeout(()=>{if(!editor?.focusWithin()){metadataDirty=false;renderAll()}},0)})
}
const textHash=createTextHashCache()
start().catch(error=>{$('main').innerHTML=`<div class="card empty"><h2>${t('Unable to open rebuttal','Rebuttal을 열 수 없습니다')}</h2><p>${esc(error.message)}</p>${action('refresh',t('Retry','다시 시도'))}</div>`;notice(error.message,true)})

async function reconcileFreshness() {
  if(!sessionReady || sessionBindings.closed)return
  const captured=state, values=Object.fromEntries(state.rounds.flatMap(r=>r.documents.flatMap(doc=>{
    const text=sharedTexts.get(doc.text_key || doc.id)
    return text?.doc===session.document ? [[doc.id,text.toString()]] : []
  })))
  const hashes=Object.fromEntries(await Promise.all(Object.entries(values).map(async([id,value])=>[id,await textHash(value)])))
  if(state!==captured || sessionBindings.closed)return
  let changed=false
  for(const r of state.rounds){
    if(!readOnly)for(const doc of r.documents){if(r.text_hashes?.[doc.id] && hashes[doc.id] && hashes[doc.id]!==r.text_hashes[doc.id] && sharedTexts.get(doc.text_key || doc.id)?.toString()===values[doc.id] && !pendingStale.has(doc.id)){
      responseRevisions.queue(doc.id, hasActiveAnalysis())
    }}
    for(const item of [...r.mappings,...r.findings]){
      const job=state.jobs.find(job=>job.input_hash===item.input_hash)
      const ids=job?.text_hashes?Object.keys(job.text_hashes):item.document_id?[item.document_id]:(item.response_spans || []).map(span=>span.document_id)
      const stale=ids.some(id=>job?.text_hashes?.[id] && hashes[id] && hashes[id]!==job.text_hashes[id]) || (item.response_spans || []).some(span=>span.content_hash && hashes[span.document_id] && hashes[span.document_id]!==span.content_hash)
      if(stale && !item.stale){item.stale=true;changed=true}
    }
  }
  if(changed){updateFreshnessUI();if(!editor?.focusWithin() && !$('form-dialog').open)renderAll();else metadataDirty=true}
}
function reviewRuleCandidates(id) {
  const job=state.jobs.find(job=>job.id===id),active=round().rules.find(rule=>rule.id===round().active_rules_id)
  showDialog(t('Review official rule candidates','공식 규정 후보 검토'),`<p class="form-help">${t('Confirm venue, year, track and official sources. Open a candidate to edit it and save a draft. Apply the draft explicitly from Overview.','학회, 연도, 트랙과 공식 출처를 확인하세요. 후보를 열어 수정하고 초안을 저장한 뒤 개요에서 직접 적용하세요.')}</p>${job.result.rules_candidates.map((candidate,index)=>`<section class="preview-review"><h3>${esc(candidate.venue)} · ${esc(candidate.year)} · ${esc(candidate.track)} · ${esc(candidate.stage)}</h3>${ruleSources(candidate)}<div class="rule-diff"><div><h3>${t('Currently applied','현재 적용')}</h3><pre>${esc(JSON.stringify(active || {},null,2))}</pre></div><div><h3>${t('Candidate','후보')}</h3><pre>${esc(JSON.stringify(candidate,null,2))}</pre></div></div>${action('candidate-rules',t('Edit candidate & create draft','후보 수정 후 초안 만들기'),`${job.id}:${index}`,'primary')}</section>`).join('')}`,null)
}
function archiveExport() {
  liveTextsFor()
  showDialog(t('Archive export','보관용 내보내기'),`<p>${t('This archive includes original reviews, translations, concerns, mappings, internal analysis, comments and response texts. Use submission exports for response-only files.','이 보관 파일에는 리뷰 원문, 번역, 우려 사항, 연결, 내부 분석, 댓글과 답변 본문이 포함됩니다. 답변 본문만 필요하면 제출 화면에서 내보내세요.')}</p>`+selectField('archive-format',t('Archive format','보관 형식'),[['json','JSON'],['zip','ZIP']],'json'),async data=>{const id=roundId;await flushResponseRevisions();if(roundId!==id)return false;const result=await mutate(`/rounds/${id}/exports`,{format:data.get('archive-format'),texts:liveTextsFor(),target:{document_ids:round().documents.map(doc=>doc.id),common_mode:'include'}});download(result.result || result)},t('Download archive','보관 파일 다운로드'))
}

function updateFreshnessUI(){
  for(const node of document.querySelectorAll('[data-finding-id]')){
    const finding=round()?.findings.find(item=>item.id===node.dataset.findingId)
    if(!finding?.stale)continue
    const label=node.querySelector('[data-finding-state]');if(label){label.textContent=statusText('stale');label.className='badge warn'}
    const button=node.querySelector('[data-action="apply-finding"]');if(button)button.disabled=true
  }
  let hasMissingPassage=false
  for(const node of document.querySelectorAll('.mapping[data-mapping-id]')){
    const mapping=round()?.mappings.find(item=>item.id===node.dataset.mappingId)
    if(!mapping)continue
    if(mapping.stale){const label=node.querySelector('[data-document-staleness]');if(label)label.textContent=statusText('stale')}
    let missing=false
    for(const button of node.querySelectorAll('[data-action="focus-span"]')){
      const span=(mapping.response_spans || []).find(item=>item.document_id===button.dataset.document && item.quote===(button.dataset.sourceQuote || button.textContent))
      const value=texts()[button.dataset.document],doc=round()?.documents.find(item=>item.id===button.dataset.document)
      const available=sessionReady && span && typeof value==='string' && Boolean(verifiedResponseSpan(span,value)) && (answerLanguage!=='ko' || Boolean(koreanResponseRange(span,doc)))
      button.disabled=!available
      if(sessionReady && !available)missing=true
    }
    const note=node.querySelector('[data-stale-note]');if(note)note.hidden=!missing
    hasMissingPassage ||= missing
  }
  for(const notice of document.querySelectorAll('[data-connection-stale-notice]'))notice.hidden=!hasMissingPassage
}

function renderSyncStatus(){
  const source=responseSourceStatus(), issue=source && source.state!=='synced'
  const status=connectionStatus==='synced'?(issue?(source.state==='conflict'?t('Conflicting edits preserved','동시 수정 보존됨'):t('Check server file','서버 파일 확인 필요')):t('Synced','동기화됨')):['connected','connecting'].includes(connectionStatus)?t('Connecting…','연결 중…'):t('Offline','오프라인')
  const health=connectionStatus==='disconnected'||issue?'error':connectionStatus==='synced'?'healthy':'pending'
  $('sync-state').textContent=status;$('collab-status').className='status-dot '+(health==='error'?'error':health==='healthy'?'':'connecting')
  const trigger=$('status-center-toggle'),label=t(`Workspace status: ${status}. View details`,`작업공간 상태: ${status}. 세부정보 보기`)
  trigger.title=label;trigger.setAttribute('aria-label',label);trigger.dataset.health=health
  const content=`<div class="status-center-list"><div data-health="${health}"><span class="status-icon" aria-hidden="true"></span><span><strong>${t('Collaboration','공동 편집')}</strong><small>${esc(status)}</small></span></div></div>${responseSourceDetails()}`
  if(statusCenter.body.innerHTML!==content)statusCenter.body.innerHTML=content
  renderProjectPresence()
}
