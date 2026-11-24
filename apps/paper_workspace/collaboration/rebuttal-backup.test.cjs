const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {resolve} = require('node:path')
const {runInNewContext} = require('node:vm')
const Y = require('yjs')

function setup({whenReady = Promise.resolve(), synced = true, onRestore, onInitialize, restoreBody} = {}) {
  const requests = [], initializations = []
  const document = new Y.Doc(), values = document.getMap('rebuttalResponses')
  const setText = (key, value) => {
    const text = new Y.Text()
    values.set(key, text)
    text.insert(0, value)
    return text
  }
  const initialize = entries => {
    for (const {key, initial} of entries) if (!values.has(key)) setText(key, initial)
  }
  setText('old-key', 'latest shared text')
  const session = {whenReady, provider: {synced}, document, ensureNamespacedTexts: async (namespace, entries) => {
    assert.equal(namespace, 'rebuttalResponses')
    initializations.push(entries)
    initialize(entries)
    onInitialize?.({document, values, setText})
  }}
  const window = {JSON}; window.parent = window
  runInNewContext(readFileSync(resolve(__dirname, '../static/rebuttal-backup.js'), 'utf8'), {window, fetch: async (url, options) => {
    requests.push({url, options})
    const body = url.endsWith('/restore') ? restoreBody || {revision: 3, result: {texts: {'new-key': 'restored response'}}} : url.endsWith('/state') ? {revision: 2} : {schema_version: 1, revision: 2, rounds: [{documents: [{id: 'old-id', text_key: 'old-key', seed_text: 'old seed'}]}]}
    if (url.endsWith('/restore')) onRestore?.({body, document, values, initialize, setText})
    return {ok: true, status: 200, json: async () => body}
  }})
  return {adapter: window.PaperRebuttalBackup.create({projectSlug: 'example-paper', session}), requests, initializations, values, document, session, setText}
}

const koreanBackup = () => ({schema_version: 1, rounds: [{id: 'round', documents: [{id: 'old-id'}]}], texts: {'old-id': 'restored response'}, koreanResponses: {'old-id': {text: '직접 작성한 초안', meta: {source: 'restored response', translation: '직접 작성한 초안'}}}})
const restoredKorean = () => ({rounds: [{id: 'new-round', documents: [{id: 'new-key', korean_seed: {text: '직접 작성한 초안', meta: {source: 'restored response', translation: '직접 작성한 초안'}}}]}], result: {texts: {'new-key': 'restored response'}, id_map: {round: 'new-round', 'old-id': 'new-key'}}})

test('backup uses the current shared response rather than an old seed', async () => {
  const {adapter} = setup()
  await adapter.refresh()
  assert.equal(adapter.snapshot().texts['old-key'], 'latest shared text')
})

test('backup rejects pending initial collaboration even when the snapshot has a seed', async () => {
  const {adapter, values} = setup({whenReady: new Promise(() => {})})
  values.clear()
  await adapter.refresh()
  assert.throws(() => adapter.snapshot(), /synchronization/)
})

test('backup rejects a missing or non-text live response instead of using a seed', async () => {
  const {adapter, values} = setup()
  await adapter.refresh()
  values.clear()
  assert.throws(() => adapter.snapshot(), /response is unavailable/)
  values.set('old-key', 'not a Y.Text')
  assert.throws(() => adapter.snapshot(), /response is unavailable/)
})

test('backup preserves a real empty live response and Korean draft', async () => {
  const {adapter, setText} = setup()
  setText('old-key', '')
  setText('ko:old-id', '')
  await adapter.refresh()
  const saved = adapter.snapshot()
  assert.equal(saved.texts['old-key'], '')
  assert.equal(saved.koreanResponses['old-id'].text, '')
})

test('backup requires the live Korean draft when an immutable seed exists, and never substitutes that seed', async () => {
  const {adapter, setText} = setup()
  const snapshot = await adapter.refresh()
  snapshot.rounds[0].documents[0].korean_seed = {text: 'old Korean seed', meta: null}
  assert.throws(() => adapter.snapshot(), /Korean response is unavailable/)
  setText('ko:old-id', 'current Korean edits')
  assert.equal(adapter.snapshot().koreanResponses['old-id'].text, 'current Korean edits')
})

test('backup rejects a disconnected provider after initial readiness', async () => {
  const {adapter} = setup({synced: false})
  await adapter.refresh()
  assert.throws(() => adapter.snapshot(), /synchronization/)
})

test('legacy backups preserve current rebuttal and issue no restore request', async () => {
  const {adapter, requests} = setup()
  await adapter.restore(undefined)
  assert.equal(requests.length, 0)
})

test('restore blocks before any API request until initial collaboration is ready', async () => {
  const {adapter, requests} = setup({whenReady: new Promise(() => {})})
  await assert.rejects(adapter.restore({schema_version: 1, rounds: []}), /synchronization/)
  assert.equal(requests.length, 0)
})

test('restore blocks before any API request when collaboration is disconnected', async () => {
  const {adapter, requests} = setup({synced: false})
  await assert.rejects(adapter.restore({schema_version: 1, rounds: []}), /synchronization/)
  assert.equal(requests.length, 0)
})

test('restore seeds cloned keys without changing the active text', async () => {
  const {adapter, requests, values} = setup()
  await adapter.restore({schema_version: 1, rounds: [], texts: {}})
  assert.equal(values.get('old-key').toString(), 'latest shared text')
  assert.equal(values.get('new-key').toString(), 'restored response')
  const request = requests.find(request => request.url.endsWith('/restore'))
  assert.equal(JSON.parse(request.options.body).expected_revision, 2)
})

test('late restore initialization preserves a collaborator editing the cloned round, including an empty text', async () => {
  for (const initial of ['', 'collaborator already edited the restored response']) {
    const {adapter, values, setText} = setup()
    setText('new-key', initial)
    await adapter.restore({schema_version: 1, rounds: [], texts: {}})
    assert.equal(values.get('new-key').toString(), initial)
  }
})

test('restore initializes both languages in one batch using the published immutable Korean seed', async () => {
  const {adapter, values, initializations, document} = setup({restoreBody: restoredKorean()})
  await adapter.restore(koreanBackup())
  assert.equal(initializations.length, 1)
  assert.equal(initializations[0].length, 2)
  assert.equal(values.get('ko:new-key').toString(), '직접 작성한 초안')
  assert.equal(document.getMap('rebuttalKoreanMeta').get('new-key').source, 'restored response')
})

test('restore falls back to the saved Korean draft and mapped document ID for older restore responses', async () => {
  const restoreBody = restoredKorean(); delete restoreBody.rounds
  const {adapter, values} = setup({restoreBody})
  await adapter.restore(koreanBackup())
  assert.equal(values.get('ko:new-key').toString(), '직접 작성한 초안')
})

test('a second tab opening the published round first initializes the same manual Korean draft', async () => {
  const {adapter, values} = setup({restoreBody: restoredKorean(), onRestore: ({body, initialize}) => {
    const doc = body.rounds[0].documents[0]
    initialize([{key: `ko:${doc.id}`, initial: doc.korean_seed.text}])
  }})
  await adapter.restore(koreanBackup())
  assert.equal(values.get('ko:new-key').toString(), '직접 작성한 초안')
})

test('late Korean restore preserves existing drafts and only adds metadata for identical backup text', async () => {
  for (const initial of ['', '다른 탭의 번역 또는 수정']) {
    const {adapter, values, document} = setup({restoreBody: restoredKorean(), onRestore: ({setText}) => setText('ko:new-key', initial)})
    await adapter.restore(koreanBackup())
    assert.equal(values.get('ko:new-key').toString(), initial)
    assert.equal(document.getMap('rebuttalKoreanMeta').has('new-key'), false)
  }
})

test('late Korean restore preserves metadata owned by a collaborating tab', async () => {
  const {adapter, document} = setup({restoreBody: restoredKorean(), onInitialize: ({document}) => {
    document.getMap('rebuttalKoreanMeta').set('new-key', {source: 'collaborator source'})
  }})
  await adapter.restore(koreanBackup())
  assert.equal(document.getMap('rebuttalKoreanMeta').get('new-key').source, 'collaborator source')
})
