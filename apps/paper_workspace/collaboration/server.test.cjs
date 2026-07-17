'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const WebSocket = require('ws')
const Y = require('yjs')
const encoding = require('lib0/encoding')
const syncProtocol = require('y-protocols/sync')
const { createCollaborationServer, messageDocumentGrowthBytes, prepareCollaborationDocument, requestRoom, roomHost } = require('./server.cjs')
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

test('room parser accepts only the workspace room namespace', () => {
  assert.equal(requestRoom({ url: '/collab/paper-workspace%3Apaper.example%3Aexample-paper' }), 'paper-workspace:paper.example:example-paper')
  assert.equal(requestRoom({ url: '/collab/arbitrary-room' }), null)
  assert.equal(requestRoom({ url: '/collab/paper-workspace%3Apaper.example%3A..%2Fsecret' }), null)
  assert.equal(roomHost('paper-workspace:paper.example:example-paper'), 'paper.example')
  assert.equal(roomHost('paper-workspace:paper.example:8443:example-paper'), 'paper.example:8443')
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
