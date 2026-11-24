import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {isManualKoreanDraft} from '../static/rebuttal-response-language.js'
import {createKoreanTranslation, publishKoreanTranslation} from '../static/rebuttal-translation.js'
import {createResponseRevisionSync, createSessionBindings} from '../static/rebuttal-session.js'
import {createRebuttalComments} from '../static/rebuttal-comments.js'
import {checkLimits, isBlockingLimit} from '../static/rebuttal-model.js'

test('Korean provenance identifies manual drafts even when English or glossary changes', () => {
  const original = {source:'old English',translation:'자동 번역',glossary:{term:'용어'}}
  assert.equal(isManualKoreanDraft('자동 번역',original),false)
  assert.equal(isManualKoreanDraft('직접 수정',original),true)
  assert.equal(isManualKoreanDraft('',original),true)
  assert.equal(isManualKoreanDraft('복원한 초안',null),true)
  assert.equal(isManualKoreanDraft('',null),false)
})

test('publication preserves a concurrent manual draft and commits accepted text and metadata atomically', () => {
  const doc = new Y.Doc(), remote = new Y.Doc()
  const text = doc.getText('ko'), metadata = doc.getMap('meta')
  text.insert(0,'직접 수정')
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  const seen = []
  remote.on('afterTransaction',()=>{
    seen.push([remote.getText('ko').toString(),remote.getMap('meta').get('id')?.translation])
  })
  doc.on('update', update=>Y.applyUpdate(remote,update))
  const options = {text,metadata,id:'id',source:'English',result:{text:'자동 번역',segments:[]},glossary:{},owner:{JSON}}
  assert.equal(publishKoreanTranslation({...options,expected:'오래된 내용'}),false)
  assert.equal(text.toString(),'직접 수정')
  assert.equal(metadata.has('id'),false)
  assert.deepEqual(seen,[])
  assert.equal(publishKoreanTranslation({...options,expected:'직접 수정'}),true)
  assert.deepEqual(seen,[['자동 번역','자동 번역']])
  assert.equal(metadata.get('id').source,'English')
})

test('iframe pagehide detaches response, memo, and provider listeners without destroying shared state', () => {
  const frame = new EventTarget(), doc = new Y.Doc(), provider = new EventTarget()
  provider.on = provider.addEventListener
  provider.off = provider.removeEventListener
  const bindings = createSessionBindings(frame), text = doc.getText('response')
  const comments = createRebuttalComments({})
  const maps = new Map()
  let responseUpdates = 0, providerUpdates = 0, memoObservers = 0
  for (const key of ['rebuttalMemoEntries','rebuttalMemoEvents']) {
    const map = doc.getMap(key)
    const listeners = new Set()
    maps.set(key,{
      observe(listener) {listeners.add(listener);memoObservers++},
      unobserve(listener) {if(listeners.delete(listener))memoObservers--},
      set: map.set.bind(map)
    })
  }
  bindings.observe(text,()=>responseUpdates++)
  bindings.on(provider,'sync',()=>providerUpdates++)
  comments.init({mapFor:key=>maps.get(key)})
  bindings.add(comments.destroy)
  text.insert(0,'before')
  provider.dispatchEvent(new Event('sync'))
  assert.equal(memoObservers,2)
  frame.dispatchEvent(new Event('pagehide'))
  assert.equal(memoObservers,0)
  text.insert(text.length,' after')
  provider.dispatchEvent(new Event('sync'))
  frame.dispatchEvent(new Event('unload'))
  assert.equal(responseUpdates,1)
  assert.equal(providerUpdates,1)
  assert.equal(text.toString(),'before after')
})

test('only authoritative mechanical violations disable submission', () => {
  const round = {documents:[{id:'answer'}],active_rules_id:'r',rules:[{id:'r',limits:[
    {basis:'rendered',unit:'characters',scope:'target',max:4},
    {basis:'raw',unit:'characters',scope:'target',max:4}
  ]}]}
  const [rendered,raw] = checkLimits(round,{answer:'**over** limit'})
  assert.equal(rendered.passed,false)
  assert.equal(isBlockingLimit(rendered),false)
  assert.equal(isBlockingLimit(raw),true)
})

test('mounting Korean after source and glossary edits queues only untouched translations', async () => {
  const doc = new Y.Doc(), response = {id:'answer'}
  const english = doc.getText('english'), korean = new Y.Text()
  const responses = doc.getMap('rebuttalResponses'), meta = doc.getMap('rebuttalKoreanMeta')
  responses.set('ko:answer',korean)
  english.insert(0,'Revised English')
  korean.insert(0,'원래 번역')
  meta.set('answer',{source:'Old English',translation:'원래 번역',glossary:{}})
  const sessionBindings = createSessionBindings(new EventTarget())
  const host = {querySelector:()=>null,classList:{toggle(){}}}
  let automatic = 0
  const {mountKorean} = createKoreanTranslation({
    $:()=>host, t:english=>english, documentFor:()=>response,
    sharedTexts:new Map([['answer',english]]), sessionBindings,
    getSession:()=>({document:doc,mapFor:name=>doc.getMap(name)}),
    isSessionReady:()=>true, getRounds:()=>[{documents:[response],glossary:{term:'용어'}}],
    getAnswerLanguage:()=>'ko', isPreview:()=>false, isReviewVisible:()=>true,
    guard:()=>automatic++, scheduleEdges(){}, restoreLanguagePosition(){}
  })
  await mountKorean()
  assert.equal(automatic,1)
  korean.insert(korean.length,'에 추가한 문장')
  await mountKorean()
  assert.equal(automatic,1)
  assert.equal(korean.toString(),'원래 번역에 추가한 문장')
  korean.delete(0,korean.length)
  await mountKorean()
  assert.equal(automatic,1)
})

test('explicit response revision flush drains debounced edits and edits received during the request', async () => {
  let release
  const firstRequest = new Promise(resolve=>{release=resolve})
  const writes = []
  const revisions = createResponseRevisionSync({
    enabled:()=>true,isBusy:()=>false,persist:async ids=>{
      writes.push([...ids])
      if(writes.length===1)await firstRequest
    }
  })
  revisions.queue('first')
  const action = revisions.flush()
  await Promise.resolve()
  assert.deepEqual(writes,[['first']])
  revisions.queue('first')
  revisions.queue('second')
  release()
  await action
  assert.deepEqual(writes,[['first'],['first','second']])
  assert.equal(revisions.pending.size,0)
  revisions.cancel()
})
