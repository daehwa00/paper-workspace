const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {runInNewContext} = require('node:vm')
const {randomUUID} = require('node:crypto')
const Y = require('yjs')

test('backup and restore remap notes, events, and passage anchors', async () => {
  const document = new Y.Doc(), map = name => document.getMap(name)
  const text = value => new Y.Text(value)
  map('rebuttalResponses').set('doc', text('hello world'))
  map('rebuttalMemoEntries').set('memo', {id:'memo', roundId:'round', scope:'round:reviewer', documentId:'doc', quote:'world', text:'note', anchorRelative:'old'})
  map('rebuttalMemoEvents').set('event', {id:'event', memoId:'memo', type:'edit', parents:['base'], text:'edited'})
  const session = {document, provider:{synced:true}, whenReady:Promise.resolve(), resolveRange:()=>[6,11], encodeTextRange:(text,start,end)=>({anchorRelative:`${start}-${end}`}), ensureNamespacedTexts:async (_, entries)=>entries.forEach(({key,initial})=>map('rebuttalResponses').set(key,text(initial)))}
  const snapshot = {schema_version:1, revision:1, rounds:[{id:'round', documents:[{id:'doc', text_key:'doc'}]}]}
  const window = {JSON}; window.parent = window
  runInNewContext(readFileSync(require('node:path').resolve(__dirname,'../static/rebuttal-backup.js'),'utf8'), {window, crypto:{randomUUID}, fetch:async url=>({ok:true,status:200,json:async()=>url.endsWith('/restore') ? {result:{texts:{newdoc:'hello world'},id_map:{round:'newround',reviewer:'newreviewer',doc:'newdoc'}}} : url.endsWith('/state') ? {revision:1} : snapshot})})
  const adapter=window.PaperRebuttalBackup.create({projectSlug:'p',session})
  await adapter.refresh(); const saved=adapter.snapshot()
  assert.deepEqual(Array.from(saved.memos[0].backupRange), [6,11])
  assert.equal(saved.memoEvents.length,1)
  await adapter.restore(saved)
  const restored=[...map('rebuttalMemoEntries').values()].find(x=>x.roundId==='newround')
  assert.equal(restored.scope,'newround:newreviewer'); assert.equal(restored.documentId,'newdoc'); assert.equal(restored.anchorRelative,'6-11')
  assert.equal([...map('rebuttalMemoEvents').values()].find(x=>x.memoId===restored.id).text,'edited')
})

test('Korean drafts and their source metadata round-trip with cloned document IDs', async () => {
  const document = new Y.Doc(), map = name => document.getMap(name)
  const text = value => new Y.Text(value)
  map('rebuttalResponses').set('doc', text('English response'))
  map('rebuttalResponses').set('ko:doc', text('한국어 답변'))
  map('rebuttalKoreanMeta').set('doc',{source:'English response',translation:'한국어 답변',segments:[]})
  const session={document,provider:{synced:true},whenReady:Promise.resolve(),ensureNamespacedTexts:async (_,entries)=>entries.forEach(({key,initial})=>{if(!map('rebuttalResponses').has(key))map('rebuttalResponses').set(key,text(initial))})}
  const snapshot={schema_version:1,revision:1,rounds:[{id:'r',documents:[{id:'doc',text_key:'doc'}]}]};const window={JSON};window.parent=window
  runInNewContext(readFileSync(require('node:path').resolve(__dirname,'../static/rebuttal-backup.js'),'utf8'),{window,crypto:{randomUUID},fetch:async url=>({ok:true,status:200,json:async()=>url.endsWith('/restore')?{result:{texts:{newdoc:'English response'},id_map:{r:'newr',doc:'newdoc'}}}:url.endsWith('/state')?{revision:1}:snapshot})})
  const adapter=window.PaperRebuttalBackup.create({projectSlug:'p',session});await adapter.refresh();const saved=adapter.snapshot()
  assert.equal(saved.koreanResponses.doc.text,'한국어 답변');await adapter.restore(saved)
  assert.equal(map('rebuttalResponses').get('ko:newdoc').toString(),'한국어 답변')
  assert.equal(map('rebuttalKoreanMeta').get('newdoc').source,'English response')
})

test('restore retries reuse the same key and round, and resume general memo events once', async () => {
  const document = new Y.Doc(), keys = [], restores = new Map()
  const memos = document.getMap('rebuttalMemoEntries'), events = document.getMap('rebuttalMemoEvents')
  const window = {JSON}; window.parent = window
  let interrupted = true
  const session = {document, provider:{synced:true}, whenReady:Promise.resolve(), async ensureNamespacedTexts() {
    if (interrupted) { interrupted = false; throw new Error('disconnected after the round was restored') }
  }}
  const saved = {schema_version:1, rounds:[{id:'r',documents:[]}],
    memos:[{id:'note',roundId:'r',reviewerId:'',scope:'r:',text:'general'}],
    memoEvents:[{id:'one',memoId:'note',type:'edit',parents:['base'],text:'new'}, {id:'two',memoId:'note',type:'edit',parents:['one'],text:'newer'}]}
  runInNewContext(readFileSync(require('node:path').resolve(__dirname,'../static/rebuttal-backup.js'),'utf8'), {window, fetch:async (url, options)=>{
    if (!url.endsWith('/restore')) return {ok:true,status:200,json:async()=>url.endsWith('/state')?{revision:restores.size}:saved}
    const {idempotency_key:key} = JSON.parse(options.body)
    assert.ok(key)
    keys.push(key)
    if (!restores.has(key)) restores.set(key, {result:{texts:{},id_map:{r:`restored-${restores.size}`}}})
    return {ok:true,status:200,json:async()=>restores.get(key)}
  }})
  const create = () => window.PaperRebuttalBackup.create({projectSlug:'p',session})
  await assert.rejects(create().restore(saved), /disconnected/)
  assert.equal(memos.size, 0)
  await create().restore(saved)
  const [memo] = memos.values()
  assert.equal(memo.reviewerId, '')
  assert.equal(memo.scope, 'restored-0:')
  assert.equal(memo.text, 'general')
  const [first, second] = events.values()
  assert.equal(first.memoId, memo.id)
  assert.equal(second.parents[0], first.id)
  memos.set(memo.id, {...memo,text:'edited after restore'})
  // Key order can change when a backup is copied through another JSON tool.
  await create().restore(Object.fromEntries(Object.entries(saved).reverse()))
  assert.equal(new Set(keys).size, 1)
  assert.equal(restores.size, 1)
  assert.equal(memos.size, 1)
  assert.equal(events.size, 2)
  assert.equal(memos.get(memo.id).text, 'edited after restore')
})
