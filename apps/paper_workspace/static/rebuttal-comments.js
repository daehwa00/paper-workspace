import { uid } from './rebuttal-model.js'

// Each memo has an independent shared key, so concurrent additions are preserved.
export function createRebuttalComments({ getDoc, getReviewerId, getRoundId, getEditor, getActor, readOnly, translate, escape, onNotice, showSource, onLayoutChange }) {
  let open = false, pending = null, currentScope = null, session = null, draft = '', editing = null, animationTimer = null, animationFrame = null
  const drafts = new Map()
  const saveDraft = () => { if (currentScope) drafts.set(currentScope, {draft, pending, editing}) }
  const $ = id => document.getElementById(id), t = translate, esc = escape
  const scope = () => `${getRoundId()}:${getDoc() && getDoc().kind !== 'reviewer' ? getDoc().id : getReviewerId() || getDoc()?.id || ''}`
  const memos = () => session?.mapFor('rebuttalMemoEntries')
  const memoEvents = () => session?.mapFor('rebuttalMemoEvents')
  function destroy() {
    memos()?.unobserve(render)
    memoEvents()?.unobserve(render)
    clearTimeout(animationTimer)
    if (animationFrame !== null) cancelAnimationFrame(animationFrame)
    session = null
  }
  function init(next) {
    if (session === next) return
    destroy()
    session = next
    memos().observe(render)
    memoEvents().observe(render)
  }
  function put(map, value) {
    // The editor can run in the Paper iframe while Yjs belongs to its parent.
    const owner=window.parent!==window && window.parent.PaperWorkspaceSharedSession===session ? window.parent : window
    map.set(value.id,owner.JSON.parse(JSON.stringify(value)))
  }
  function entriesFor(id) { return [...(memoEvents()?.values() || [])].filter(event=>event?.memoId===id) }
  function isResolved(id) { return entriesFor(id).some(event=>event.type==='resolve') }
  function heads(item) {
    const edits=entriesFor(item.id).filter(event=>event.type==='edit' && typeof event.text==='string')
    if(!edits.length)return [{id:'base',text:item.text,author:item.author,createdAt:item.createdAt}]
    const superseded=new Set(edits.flatMap(event=>Array.isArray(event.parents)?event.parents:[]))
    return edits.filter(event=>!superseded.has(event.id)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)))
  }
  function visibleMemos() {return [...memos().values()].filter(item=>item?.scope===scope() && !isResolved(item.id)).sort((a,b)=>(b.createdAt || '').localeCompare(a.createdAt || '') || String(b.id).localeCompare(String(a.id)))}
  function checkedRange(item) {
    if(!item.quote || item.documentId!==getDoc()?.id)return null
    const doc=getDoc(),text=session?.mapFor('rebuttalResponses').get(doc.text_key || doc.id)
    if(!text || !getEditor())return null
    const range=session.resolveRange(item,text)
    return range && range[0]<range[1] && text.toString().slice(range[0],range[1])===item.quote ? range : null
  }
  function render() {
    const list=$('rebuttal-memo-list');if(!list || !session)return
    const active=document.activeElement,focusId=active?.classList.contains('response-memo-edit-input') ? active.closest('[data-memo]')?.dataset.memo : null
    const focusStart=focusId ? active.selectionStart : null, focusEnd=focusId ? active.selectionEnd : null
    const saved=visibleMemos()
    list.innerHTML=saved.length?saved.map(item=>{
      const valid=item.quote && checkedRange(item), date=new Date(item.createdAt), versions=heads(item)
      const time=Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(document.documentElement.lang==='ko'?'ko-KR':'en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date)
      const conflict=versions.length>1?`<div class="response-memo-conflict"><strong>${t('Concurrent edits','동시 수정된 내용')}</strong>${versions.map(version=>`<p><span>${esc(version.author || '')}</span> ${esc(version.text)}</p>`).join('')}</div>`:''
      const body=editing?.id===item.id ? `<textarea class="response-memo-edit-input" maxlength="4000" aria-label="${t('Edit note','메모 수정')}">${esc(editing.text)}</textarea><div class="response-memo-edit-actions"><button type="button" data-memo-action="edit-cancel" data-id="${esc(item.id)}">${t('Cancel','취소')}</button><button type="button" class="primary" data-memo-action="edit-save" data-id="${esc(item.id)}">${t('Save','저장')}</button></div>` : `<p class="response-memo-body">${esc(versions[0]?.text || '')}</p>`
      return `<article class="response-memo" data-memo="${esc(item.id)}"><div class="response-memo-message"><div class="response-memo-meta"><strong>${esc(item.author)}</strong><time datetime="${esc(item.createdAt)}" title="${esc(date.toLocaleString())}">${esc(time)}</time>${!readOnly?`<div class="response-memo-item-actions"><button type="button" data-memo-action="edit" data-id="${esc(item.id)}">${t('Edit','수정')}</button><button type="button" data-memo-action="resolve" data-id="${esc(item.id)}">${t('Resolve','해결')}</button></div>`:''}</div>${conflict}${body}${item.quote?`<button type="button" class="response-memo-quote" data-memo-action="focus" data-id="${esc(item.id)}" title="${esc(item.quote)}" ${valid?'':'disabled'}>${esc(item.quote)}</button>${valid?'':`<p class="response-memo-changed">${t('Original passage changed','원문 변경됨')}</p>`}`:''}</div></article>`
    }).join(''):`<p class="response-memo-empty">${t('No notes yet.','아직 메모가 없습니다.')}</p>`
    if(focusId){const restored=list.querySelector(`[data-memo="${CSS.escape(focusId)}"] .response-memo-edit-input`);if(restored){restored.focus();restored.setSelectionRange(focusStart,focusEnd)}}
    const count=$('response-memos-count');if(count)count.textContent=saved.length || ''
    renderMarkers(saved)
  }
  function setOpen(value, { immediate = false } = {}) {
    const panel=$('response-memos-panel'),toggle=$('response-memos-toggle'),workspace=$('mapping-workspace')
    if(!panel || !toggle || !workspace)return
    clearTimeout(animationTimer);if(animationFrame)cancelAnimationFrame(animationFrame)
    const resizer=$('response-memos-resizer')
    open=Boolean(value);toggle.setAttribute('aria-expanded',String(open));panel.inert=!open;panel.setAttribute('aria-hidden',String(!open));if(resizer){resizer.hidden=!open;resizer.inert=!open}
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if(immediate || reduced){panel.hidden=!open;workspace.classList.toggle('memo-panel-open',open);workspace.classList.remove('memo-panel-animating');onLayoutChange?.();return}
    workspace.classList.add('memo-panel-animating')
    if(open){
      panel.hidden=false
      animationFrame=requestAnimationFrame(()=>{animationFrame=requestAnimationFrame(()=>{workspace.classList.add('memo-panel-open');onLayoutChange?.()})})
    } else {workspace.classList.remove('memo-panel-open');onLayoutChange?.()}
    animationTimer=setTimeout(()=>{if(!open)panel.hidden=true;workspace.classList.remove('memo-panel-animating');onLayoutChange?.()},260)
  }
  function renderMarkers(saved) {
    const host=$('response-memo-anchors'), editor=getEditor(), container=$('response-editor')
    if(!host || !editor || !container || !session)return
    const bounds=container.getBoundingClientRect()
    if(!bounds.width || !bounds.height){host.replaceChildren();return}
    const items=saved || visibleMemos()
    const markers=[]
    for(const item of items){
      const range=checkedRange(item);if(!range)continue
      const coords=editor.view.coordsAtPos(range[0]);if(!coords)continue
      const top=coords.top-bounds.top;if(top<0 || top>bounds.height-10)continue
      const marker=document.createElement('button');marker.type='button';marker.className='response-memo-marker';marker.style.top=`${top}px`;marker.textContent='•';marker.setAttribute('aria-label',t('Open note on this passage','이 구절의 메모 열기'))
      marker.onclick=()=>{const panel=$('response-memos-panel');setOpen(true);render();requestAnimationFrame(()=>panel.querySelector(`[data-memo="${CSS.escape(item.id)}"]`)?.scrollIntoView({block:'nearest'}))}
      markers.push(marker)
    }
    host.replaceChildren(...markers)
  }
  function renderPending(){const selected=$('rebuttal-memo-selected');if(!selected)return;selected.hidden=!pending;selected.textContent=pending?.quote || '';const clear=$('response-memos-panel')?.querySelector('[data-memo-action=clear]');if(clear)clear.hidden=!pending}
  function selectionChanged(){const button=$('response-memo-add'),editor=getEditor(),selection=editor?.getSelection();if(!button)return;button.hidden=readOnly || !getDoc() || !selection || selection.start===selection.end;if(!button.hidden){const host=$('response-editor'),bounds=host.getBoundingClientRect(),point=editor.view.coordsAtPos(selection.end);if(point){button.style.left=`${Math.max(6,Math.min(bounds.width-button.offsetWidth-6,point.right-bounds.left+8))}px`;button.style.top=`${Math.max(6,Math.min(bounds.height-button.offsetHeight-6,point.top-bounds.top-button.offsetHeight-6))}px`}}}
  function mount() {
    const panel=$('response-memos-panel'),toggle=$('response-memos-toggle'),input=$('rebuttal-memo-input')
    if(!panel || !toggle || !input || !session)return
    const next=scope();if(currentScope!==next){saveDraft();currentScope=next;({draft='',pending=null,editing=null}=drafts.get(next) || {})}
    setOpen(open,{immediate:true});input.value=draft;input.readOnly=readOnly
    input.oninput=()=>{draft=input.value;saveDraft()}
    panel.oninput=event=>{if(event.target.classList.contains('response-memo-edit-input') && editing){editing.text=event.target.value;saveDraft()}}
    const resizer=$('response-memos-resizer'),workspace=$('mapping-workspace')
    if(resizer && workspace){
      let width=Number(window.PaperPreferenceStorage?.get('paper-rebuttal-memo-width')) || 312
      const limits=()=>{const available=window.innerWidth>=1200 ? Math.min(600,workspace.clientWidth*.52) : Math.min(600,window.innerWidth-16);return {min:Math.min(240,available),max:available}}
      const apply=value=>{const {min,max}=limits();width=Math.max(min,Math.min(max,value));workspace.style.setProperty('--memo-width',`${width}px`);resizer.setAttribute('aria-valuemin',String(Math.round(min)));resizer.setAttribute('aria-valuemax',String(Math.round(max)));resizer.setAttribute('aria-valuenow',String(Math.round(width)));onLayoutChange?.()}
      apply(width)
      window.PaperUI.bindResizer({element:resizer,step:24,direction:-1,enabled:()=>open,getValue:()=>width,getPointerValue:()=>panel.getBoundingClientRect().width,getLimits:limits,fromPointer:(event,start)=>start.value-(event.clientX-start.x),onChange:apply,onCommit:()=>window.PaperPreferenceStorage?.set('paper-rebuttal-memo-width',String(width))})
    }
    toggle.onclick=()=>{setOpen(!open);if(open){render();renderPending()}}
    const add=$('response-memo-add')
    if(add)add.onmousedown=event=>event.preventDefault()
    if(add)add.onclick=()=>{
      const doc=getDoc(),sel=getEditor()?.getSelection(),shared=doc && session.mapFor('rebuttalResponses').get(doc.text_key || doc.id)
      if(readOnly || !shared || !sel || sel.start===sel.end)return
      const quote=shared.toString().slice(sel.start,sel.end)
      if(!quote.trim() || quote.length>2000){onNotice(t('Select up to 2,000 characters.','2,000자 이내의 구절을 선택하세요.'),true);return}
      pending={documentId:doc.id,quote,...session.encodeTextRange(shared,sel.start,sel.end)};saveDraft()
      setOpen(true);renderPending();input.focus()
    }
    panel.onclick=event=>{
      const button=event.target.closest('[data-memo-action]');if(!button || button.disabled)return
      const action=button.dataset.memoAction
      if(action==='close'){setOpen(false);toggle.focus();return}
      if(action==='clear'){pending=null;saveDraft();renderPending();return}
      if(action==='save'){
        const text=input.value.trim();if(readOnly || !text || !getRoundId())return
        if(pending && !checkedRange(pending)){onNotice(t('The selected passage changed. Select it again.','선택한 구절이 변경됐습니다. 다시 선택하세요.'),true);return}
        const id=uid(),actor=getActor()
        const value={id,scope:scope(),roundId:getRoundId(),...(pending || {}),text:text.slice(0,4000),author:String(actor?.name || 'Author').slice(0,120),createdAt:new Date().toISOString()}
        put(memos(),value)
        pending=null;draft='';saveDraft();input.value='';renderPending();return
      }
      if(['edit','edit-save','edit-cancel','resolve'].includes(action)){
        const item=memos().get(button.dataset.id)
        if(readOnly || !item || item.scope!==scope() || isResolved(item.id))return
        if(action==='edit'){if(editing && editing.id!==item.id){onNotice(t('Finish or cancel the note you are editing first.','수정 중인 메모를 저장하거나 취소한 뒤 다른 메모를 수정하세요.'),true);return}const versions=heads(item);editing={id:item.id,parents:versions.map(version=>version.id),text:versions[0]?.text || ''};saveDraft();render();$('rebuttal-memo-list')?.querySelector(`[data-memo="${CSS.escape(item.id)}"] .response-memo-edit-input`)?.focus();return}
        if(action==='edit-cancel'){editing=null;saveDraft();render();return}
        if(action==='resolve'){if(editing?.id===item.id)editing=null;saveDraft();put(memoEvents(),{id:uid(),memoId:item.id,type:'resolve',author:String(getActor()?.name || 'Author').slice(0,120),createdAt:new Date().toISOString()});return}
        if(action==='edit-save' && editing?.id===item.id){
          const value=editing.text.trim();if(!value)return
          const current=heads(item).map(version=>version.id).sort(), base=editing.parents.slice().sort()
          if(JSON.stringify(current)!==JSON.stringify(base)){onNotice(t('This note changed while you were editing. Your draft is preserved; copy it and reopen the latest note.','수정하는 동안 메모가 변경됐습니다. 작성한 내용은 유지됩니다. 내용을 복사한 뒤 최신 메모를 다시 열어주세요.'),true);return}
          const event={id:uid(),memoId:item.id,type:'edit',parents:editing.parents,text:value.slice(0,4000),author:String(getActor()?.name || 'Author').slice(0,120),createdAt:new Date().toISOString()};editing=null;saveDraft();put(memoEvents(),event);return
        }
      }
      if(action==='focus'){
        const item=memos().get(button.dataset.id),range=item && checkedRange(item);if(!range)return
        showSource?.();const editor=getEditor();editor.setSelection(range[0],range[1],{scroll:true});editor.focus()
      }
    }
    render();renderPending();selectionChanged()
  }
  return {init,destroy,mount,selectionChanged,refreshAnchors:render,refreshMarkers:renderMarkers}
}
