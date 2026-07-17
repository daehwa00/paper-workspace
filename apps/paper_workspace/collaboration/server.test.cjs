'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const WebSocket = require('ws')
const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const encoding = require('lib0/encoding')
const syncProtocol = require('y-protocols/sync')
const { applyRuntimeSources, createCollaborationServer, messageDocumentGrowthBytes, prepareCollaborationDocument, requestRoom, roomHost, runtimeSyncRoom, sourceFingerprint } = require('./server.cjs')
const { docs, getYDoc } = require('y-websocket/bin/utils')

const listen = instance => new Promise(resolve => {
  instance.server.listen(0, '127.0.0.1', () => resolve(instance.server.address().port))
})

const responseStatus = url => new Promise((resolve, reject) => {
  http.get(url, response => {
    response.resume()
    response.on('end', () => resolve(response.statusCode))
  }).on('error', reject)
})

const postJson = (url, payload, headers = {}) => new Promise((resolve, reject) => {
  const body = Buffer.from(JSON.stringify(payload))
  const request = http.request(url, {
    method: 'POST',
    headers: {
      'Content-Length': body.length,
      'Content-Type': 'application/json',
      Origin: 'https://paper.example',
      'X-Paper-Actor': 'test-user',
      ...headers
    }
  }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolve({
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      status: response.statusCode
    }))
  })
  request.on('error', reject)
  request.end(body)
})

const writeRuntimeProject = (root, { revision, source, retiredPaths = [] }) => {
  const project = path.join(root, 'projects', 'example-paper')
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, 'main.tex'), source)
  fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({
    entrypoint: 'main.tex',
    files: [{ path: 'main.tex', managed: true }],
    retired_paths: retiredPaths,
    runtime_file_revisions: {
      'main.tex': crypto.createHash('sha256').update(source).digest('hex')
    },
    runtime_revision: revision,
    version: '1'
  }))
}

const websocketOutcome = (url, origin) => new Promise(resolve => {
  const socket = new WebSocket(url, { origin })
  socket.once('open', () => {
    socket.once('close', () => resolve('open'))
    socket.close()
  })
  socket.once('unexpected-response', (_request, response) => {
    response.resume()
    response.once('end', () => resolve(response.statusCode))
  })
  socket.once('error', () => {})
})

const oversizedWebsocketOutcome = (url, origin, bytes) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { origin })
  const timeout = setTimeout(() => reject(new Error('oversized websocket was not closed')), 2000)
  socket.once('open', () => socket.send(Buffer.alloc(bytes)))
  socket.once('close', code => {
    clearTimeout(timeout)
    resolve(code)
  })
  socket.once('error', () => {})
})

const websocketCloseCode = (url, origin, onOpen = () => {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { origin })
  const timeout = setTimeout(() => reject(new Error('websocket was not closed')), 2000)
  socket.once('open', () => onOpen(socket))
  socket.once('close', code => {
    clearTimeout(timeout)
    resolve(code)
  })
  socket.once('error', () => {})
})

class PaperOriginWebSocket extends WebSocket {
  constructor (url, protocols) {
    super(url, protocols, { origin: 'https://paper.example' })
  }
}

test('room parser accepts only the workspace room namespace', () => {
  assert.equal(requestRoom({ url: '/collab/paper-workspace%3Apaper.example%3Aexample-paper' }), 'paper-workspace:paper.example:example-paper')
  assert.equal(requestRoom({ url: '/collab/arbitrary-room' }), null)
  assert.equal(requestRoom({ url: '/collab/paper-workspace%3Apaper.example%3A..%2Fsecret' }), null)
  assert.equal(roomHost('paper-workspace:paper.example:example-paper'), 'paper.example')
  assert.equal(roomHost('paper-workspace:paper.example:8443:example-paper'), 'paper.example:8443')
  assert.equal(runtimeSyncRoom({ url: '/collab-runtime/paper-workspace%3Apaper.example%3Aexample-paper' }), 'paper-workspace:paper.example:example-paper')
})

test('runtime source application is atomic, deduplicated, and preserves connected edits', () => {
  const document = new Y.Doc()
  const files = document.getMap('files')
  const project = document.getMap('project')
  const main = new Y.Text()
  main.insert(0, 'web-edited source')
  files.set('paper/main.tex', main)
  const appendix = new Y.Text()
  appendix.insert(0, 'keep unless explicitly retired')
  files.set('paper/appendix.tex', appendix)
  project.set('serverRuntimeRevision', 'a'.repeat(64))
  project.set('serverManagedPaths', ['paper/main.tex', 'paper/appendix.tex'])
  project.set('serverSourceFingerprints', { 'paper/main.tex': sourceFingerprint('old server source') })

  const payload = {
    previousRuntimeRevision: 'a'.repeat(64),
    retiredPaths: [],
    runtimeRevision: 'b'.repeat(64),
    sources: { 'paper/main.tex': 'new server source' },
    version: '1'
  }
  const first = applyRuntimeSources(document, payload, 1234)
  assert.equal(first.deduplicated, false)
  assert.equal(files.get('paper/main.tex').toString(), 'new server source')
  assert.equal(files.get('paper/appendix.tex').toString(), 'keep unless explicitly retired')
  assert.equal(first.preserved_paths.length, 1)
  assert.equal(files.get(first.preserved_paths[0]).toString(), 'web-edited source')

  const second = applyRuntimeSources(document, payload, 5678)
  assert.equal(second.deduplicated, true)
  assert.equal(files.get('paper/main.tex').toString(), 'new server source')
  assert.equal([...files.keys()].filter(name => name.startsWith('paper/drafts/server-before-sync-')).length, 1)

  const stale = applyRuntimeSources(document, { ...payload, previousRuntimeRevision: 'a'.repeat(64), runtimeRevision: 'c'.repeat(64), sources: { 'paper/main.tex': 'stale rollback' } })
  assert.equal(stale.conflict, true)
  assert.equal(files.get('paper/main.tex').toString(), 'new server source')
  document.destroy()
})

test('runtime source application avoids needless drafts and retires only declared paths', () => {
  const document = new Y.Doc()
  const files = document.getMap('files')
  const project = document.getMap('project')
  for (const [name, value] of [['paper/main.tex', 'old server source'], ['paper/keep.tex', 'keep me'], ['paper/remove.tex', 'retire me']]) {
    const text = new Y.Text()
    text.insert(0, value)
    files.set(name, text)
  }
  project.set('serverRuntimeRevision', 'a'.repeat(64))
  project.set('serverManagedPaths', ['paper/main.tex', 'paper/keep.tex', 'paper/remove.tex'])
  project.set('serverSourceFingerprints', { 'paper/main.tex': sourceFingerprint('old server source') })
  const result = applyRuntimeSources(document, {
    previousRuntimeRevision: 'a'.repeat(64),
    retiredPaths: ['paper/remove.tex'],
    runtimeRevision: 'b'.repeat(64),
    sources: { 'paper/main.tex': 'new server source' },
    version: '1'
  }, 1234)
  assert.equal(files.get('paper/main.tex').toString(), 'new server source')
  assert.equal(files.get('paper/keep.tex').toString(), 'keep me')
  assert.equal(files.has('paper/remove.tex'), false)
  assert.equal(result.preserved_paths.length, 1)
  assert.equal(files.get(result.preserved_paths[0]).toString(), 'retire me')
  document.destroy()
})

test('runtime synchronization endpoint verifies staged sources and serializes duplicate requests', async t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-runtime-sync-'))
  t.after(() => fs.rmSync(runtime, { force: true, recursive: true }))
  const previousRevision = 'a'.repeat(64)
  const runtimeRevision = 'b'.repeat(64)
  writeRuntimeProject(runtime, { revision: runtimeRevision, source: 'new server source' })
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    projectRuntimeDir: runtime
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const room = 'paper-workspace:paper.example:example-paper'
  const docName = `collab/${room}`
  const document = getYDoc(docName)
  const main = new Y.Text()
  main.insert(0, 'connected web edit')
  document.getMap('files').set('paper/main.tex', main)
  document.getMap('project').set('serverRuntimeRevision', previousRevision)
  document.getMap('project').set('serverManagedPaths', ['paper/main.tex'])
  document.getMap('project').set('serverSourceFingerprints', { 'paper/main.tex': sourceFingerprint('old server source') })
  const clientDocument = new Y.Doc()
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, room, clientDocument, {
    WebSocketPolyfill: PaperOriginWebSocket,
    disableBc: true
  })
  t.after(() => { provider.destroy(); clientDocument.destroy() })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('test collaboration client did not synchronize')), 2000)
    provider.once('sync', synchronized => {
      if (!synchronized) return
      clearTimeout(timeout)
      resolve()
    })
  })
  const url = `http://127.0.0.1:${port}/collab-runtime/${encodeURIComponent(room)}`
  const signal = { previous_runtime_revision: previousRevision, runtime_revision: runtimeRevision }

  const [first, second] = await Promise.all([postJson(url, signal), postJson(url, signal)])
  assert.deepEqual([first.status, second.status], [200, 200])
  assert.equal(document.getMap('files').get('paper/main.tex').toString(), 'new server source')
  await new Promise(resolve => {
    const started = Date.now()
    const poll = () => clientDocument.getMap('files').get('paper/main.tex')?.toString() === 'new server source' || Date.now() - started > 2000 ? resolve() : setTimeout(poll, 10)
    poll()
  })
  assert.equal(clientDocument.getMap('files').get('paper/main.tex').toString(), 'new server source')
  const drafts = [...document.getMap('files').entries()].filter(([name]) => name.startsWith('paper/drafts/server-before-sync-'))
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0][1].toString(), 'connected web edit')
  assert.equal([first.body.deduplicated, second.body.deduplicated].filter(Boolean).length, 1)

  const stale = await postJson(url, { previous_runtime_revision: previousRevision, runtime_revision: 'c'.repeat(64) })
  assert.equal(stale.status, 409)
  assert.equal(document.getMap('files').get('paper/main.tex').toString(), 'new server source')
})

test('runtime synchronization endpoint rejects unauthenticated, forged, and unopened requests', async t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-runtime-guard-'))
  t.after(() => fs.rmSync(runtime, { force: true, recursive: true }))
  const revision = 'b'.repeat(64)
  writeRuntimeProject(runtime, { revision, source: 'verified source' })
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    projectRuntimeDir: runtime
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const room = 'paper-workspace:paper.example:example-paper'
  const url = `http://127.0.0.1:${port}/collab-runtime/${encodeURIComponent(room)}`
  const signal = { previous_runtime_revision: 'a'.repeat(64), runtime_revision: revision }
  const before = docs.size
  assert.equal((await postJson(url, signal)).status, 409)
  assert.equal(docs.size, before)
  assert.equal((await postJson(url, signal, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await postJson(url, signal, { 'X-Paper-Actor': '' })).status, 401)

  const document = getYDoc(`collab/${room}`)
  document.getMap('project').set('serverRuntimeRevision', 'a'.repeat(64))
  fs.writeFileSync(path.join(runtime, 'projects/example-paper/main.tex'), 'tampered after staging')
  assert.equal((await postJson(url, signal)).status, 409)
  assert.equal(document.getMap('files').size, 0)
  document.destroy()
  docs.delete(`collab/${room}`)
})

test('server rejects foreign origins and arbitrary rooms', async t => {
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper'])
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  assert.equal(await responseStatus(`http://127.0.0.1:${port}/health`), 200)
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:example-paper`, 'https://evil.example'), 403)
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${port}/collab/arbitrary-room`, 'https://paper.example'), 404)
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:unknown-paper`, 'https://paper.example'), 404)
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${port}/collab/paper-workspace:alias.example:example-paper`, 'https://paper.example'), 403)
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:example-paper`, 'https://paper.example'), 'open')
})

test('document synchronization waits for persistence readiness', async () => {
  const docName = `collab/paper-workspace:paper.example:readiness-${Date.now()}`
  const document = getYDoc(docName)
  let release
  document.paperPersistenceReady = new Promise(resolve => { release = resolve })
  let prepared = false
  const waiting = prepareCollaborationDocument(docName).then(() => { prepared = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(prepared, false)
  release()
  await waiting
  assert.equal(prepared, true)
  document.destroy()
  docs.delete(docName)
})

test('connections are reauthenticated and ingress is rate limited', async t => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeSyncStep1(encoder, new Y.Doc())
  const syncMessage = Buffer.from(encoding.toUint8Array(encoder))
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    maxConnectionAgeMs: 60,
    maxIngressBytesPerMinute: syncMessage.length * 2
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const url = `ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:example-paper`
  assert.equal(await websocketCloseCode(url, 'https://paper.example'), 4001)
  assert.equal(await websocketCloseCode(url, 'https://paper.example', socket => {
    socket.send(syncMessage)
    socket.send(syncMessage)
    socket.send(syncMessage)
  }), 1009)
})

test('document update growth is bounded before it reaches Yjs persistence', async t => {
  const updateDocument = new Y.Doc()
  updateDocument.getText('paper').insert(0, 'bounded update')
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(updateDocument))
  const updateMessage = Buffer.from(encoding.toUint8Array(encoder))
  assert.equal(messageDocumentGrowthBytes(updateMessage), updateMessage.length)

  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    maxDocumentBytes: updateMessage.length + 4,
    maxIngressBytesPerMinute: 1024
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const url = `ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:example-paper`
  assert.equal(await websocketCloseCode(url, 'https://paper.example', socket => {
    socket.send(updateMessage)
    socket.send(updateMessage)
  }), 1009)
})

test('server fails closed when the persistence quota is exhausted', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-collab-quota-'))
  fs.writeFileSync(path.join(directory, 'full'), Buffer.alloc(64))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    maxStorageBytes: 32,
    persistenceDir: directory
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  assert.equal(await responseStatus(`http://127.0.0.1:${port}/health`), 507)
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:example-paper`, 'https://paper.example'), 507)
})

test('oversized messages close only the offending websocket', async t => {
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    maxPayloadBytes: 64
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const url = `ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:example-paper`

  assert.ok([1006, 1009].includes(await oversizedWebsocketOutcome(url, 'https://paper.example', 65)))
  assert.equal(await responseStatus(`http://127.0.0.1:${port}/health`), 200)
  assert.equal(await websocketOutcome(url, 'https://paper.example'), 'open')
})

test('storage accounting tolerates files removed during LevelDB compaction', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-collab-compaction-'))
  const transient = path.join(directory, 'MANIFEST-transient')
  fs.writeFileSync(transient, 'manifest')
  const originalStatSync = fs.statSync
  fs.statSync = (filename, ...args) => {
    if (filename === transient) {
      fs.rmSync(transient, { force: true })
      const error = new Error('file replaced during compaction')
      error.code = 'ENOENT'
      throw error
    }
    return originalStatSync(filename, ...args)
  }
  try {
    assert.equal(require('./server.cjs').directoryBytes(directory), 0)
  } finally {
    fs.statSync = originalStatSync
    fs.rmSync(directory, { force: true, recursive: true })
  }
})
