'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const WebSocket = require('ws')
const { createCollaborationServer, requestRoom } = require('./server.cjs')

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

test('room parser accepts only the workspace room namespace', () => {
  assert.equal(requestRoom({ url: '/collab/paper-workspace%3Apaper.example%3Aexample-paper' }), 'paper-workspace:paper.example:example-paper')
  assert.equal(requestRoom({ url: '/collab/arbitrary-room' }), null)
  assert.equal(requestRoom({ url: '/collab/paper-workspace%3Apaper.example%3A..%2Fsecret' }), null)
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
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${port}/collab/paper-workspace:paper.example:example-paper`, 'https://paper.example'), 'open')
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
