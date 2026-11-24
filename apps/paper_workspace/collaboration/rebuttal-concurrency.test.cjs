'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const WebSocket = require('ws')
const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const { createCollaborationServer } = require('./server.cjs')
const { docs, getPersistence, setPersistence } = require('y-websocket/bin/utils')

const origin = 'https://paper.example'

class PaperSocket extends WebSocket {
  constructor (url, protocols) {
    super(url, protocols, { origin })
  }
}

const waitFor = (predicate, message, timeoutMs = 3000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs
  const poll = () => {
    try {
      if (predicate()) return resolve()
    } catch (error) { return reject(error) }
    if (Date.now() >= deadline) return reject(new Error(message))
    setTimeout(poll, 10)
  }
  poll()
})

const postJson = (url, payload, headers = {}) => new Promise((resolve, reject) => {
  const body = Buffer.from(JSON.stringify(payload))
  const request = http.request(url, {
    method: 'POST',
    headers: {
      'Content-Length': body.length,
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Paper-Actor': 'test-editor',
      'X-Paper-Role': 'editor',
      'X-Paper-Allowed-Projects': 'rebuttal-test',
      ...headers
    }
  }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => {
      try {
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch (error) { reject(error) }
    })
  })
  request.on('error', reject)
  request.end(body)
})

const setup = async (t, sourceRoot) => {
  const room = 'paper-workspace:paper.example:rebuttal-test'
  const peers = []
  if (sourceRoot) {
    fs.writeFileSync(path.join(sourceRoot, 'main.tex'), '')
    fs.writeFileSync(path.join(sourceRoot, 'project.json'), JSON.stringify({
      entrypoint: 'main.tex', files: [{ path: 'main.tex', managed: true }]
    }))
  }
  const instance = createCollaborationServer({
    allowedOrigins: new Set([origin]),
    allowedProjectSlugs: new Set(['rebuttal-test']),
    defaultProjectSlugs: new Set(['rebuttal-test']),
    defaultProjectSourceDir: sourceRoot || '',
    rebuttalSourcePollMs: 20,
    sourceWritebackDebounceMs: 10
  })
  t.after(async () => {
    for (const { provider, document } of peers) {
      provider.destroy()
      document.destroy()
    }
    await instance.close()
    if (sourceRoot) fs.rmSync(sourceRoot, { recursive: true, force: true })
  })
  const port = await new Promise(resolve => instance.server.listen(0, '127.0.0.1', () => resolve(instance.server.address().port)))
  const connect = async () => {
    const document = new Y.Doc()
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, room, document, {
      WebSocketPolyfill: PaperSocket,
      disableBc: true
    })
    const peer = { document, provider }
    peers.push(peer)
    await waitFor(() => provider.synced, 'collaboration peer did not synchronize')
    return peer
  }
  const initUrl = `http://127.0.0.1:${port}/collab-runtime/${encodeURIComponent(room)}?response-init=1`
  return { connect, initUrl, serverDocument: () => docs.get(`collab/${room}`) }
}

const response = (peer, key = 'response-one') => peer.document.getMap('rebuttalResponses').get(key)

test('simultaneous response initialization shares one text and preserves both peers edits', async t => {
  const fixture = await setup(t)
  const [first, second] = await Promise.all([fixture.connect(), fixture.connect()])
  const requests = [first, second].map((peer, index) => postJson(fixture.initUrl, {
    entries: [{ key: 'response-one', initial: `seed ${index + 1}` }],
    state_vector: Buffer.from(Y.encodeStateVector(peer.document)).toString('base64')
  }))
  const results = await Promise.all(requests)
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 200)
    assert.equal(result.body.initialized, true)
    assert.equal(typeof result.body.update, 'string')
    Y.applyUpdate([first, second][index].document, Buffer.from(result.body.update, 'base64'))
  }
  assert.equal(response(first).toString(), response(second).toString())
  assert.match(response(first).toString(), /^seed [12]$/)
  response(first).insert(response(first).length, '\nAlice independent edit')
  response(second).insert(response(second).length, '\nBob independent edit')
  await waitFor(() => [first, second].every(peer => {
    const text = response(peer)?.toString() || ''
    return text.includes('Alice independent edit') && text.includes('Bob independent edit')
  }), 'one peer edit disappeared after simultaneous response initialization')
  assert.equal(response(first).toString(), response(second).toString())
  assert.equal(fixture.serverDocument().getMap('rebuttalResponses').size, 1)
})

test('response initialization rejects unauthorized or invalid writes and preserves intentionally empty text', async t => {
  const fixture = await setup(t)
  const peer = await fixture.connect()
  const payload = { entries: [{ key: 'response-one', initial: 'initial answer' }] }
  assert.equal((await postJson(fixture.initUrl, payload, { 'X-Paper-Role': 'viewer' })).status, 403)
  assert.equal((await postJson(fixture.initUrl, payload, { 'X-Paper-Actor': '' })).status, 401)
  assert.equal((await postJson(fixture.initUrl, payload, { Origin: 'https://other.example' })).status, 403)
  assert.equal((await postJson(fixture.initUrl, { entries: [{ key: '../escape', initial: 'invalid' }] })).status, 400)
  assert.equal((await postJson(fixture.initUrl, { entries: [{ key: 'response-one', initial: 42 }] })).status, 400)
  assert.equal(fixture.serverDocument().getMap('rebuttalResponses').size, 0)
  assert.equal((await postJson(fixture.initUrl, payload)).status, 200)
  await waitFor(() => response(peer)?.toString() === 'initial answer', 'initial answer did not reach the peer')
  const shared = response(peer)
  shared.delete(0, shared.length)
  await waitFor(() => fixture.serverDocument().getMap('rebuttalResponses').get('response-one').toString() === '', 'empty answer did not reach the server')
  assert.equal((await postJson(fixture.initUrl, payload)).status, 200)
  assert.equal(fixture.serverDocument().getMap('rebuttalResponses').get('response-one').toString(), '')
})

test('response initialization rejects a room destroyed while persistence readiness is pending', async t => {
  const fixture = await setup(t)
  const peer = await fixture.connect()
  const document = fixture.serverDocument()
  const responses = document.getMap('rebuttalResponses')
  let releaseReadiness
  let waitingForReadiness = false
  const readiness = new Promise(resolve => { releaseReadiness = resolve })
  Object.defineProperty(document, 'paperPersistenceReady', {
    configurable: true,
    get () {
      waitingForReadiness = true
      return readiness
    }
  })
  const pending = postJson(fixture.initUrl, { entries: [{ key: 'late-response', initial: 'must not be created' }] })
  const previousPersistence = getPersistence()
  try {
    await waitFor(() => waitingForReadiness, 'initialization did not wait for persistence readiness')
    // y-websocket destroys rooms on their last connection only when persistence
    // is configured. Model its completed close flush without opening a database.
    setPersistence({ bindState () {}, async writeState () {} })
    peer.provider.disconnect()
    await waitFor(() => document.isDestroyed && fixture.serverDocument() === undefined, 'closing the last peer did not destroy its collaboration room')
  } finally {
    setPersistence(previousPersistence)
    releaseReadiness()
  }
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(responses.has('late-response'), false)
  assert.equal(fixture.serverDocument(), undefined)
})

test('server response source edits reach both peers and browser edits write back to disk', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuttal-disk-sync-'))
  const sourceFile = path.join(sourceRoot, 'rebuttal', 'responses', 'response-one.md')
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true })
  fs.writeFileSync(sourceFile, 'server baseline\n')
  const fixture = await setup(t, sourceRoot)
  const [first, second] = await Promise.all([fixture.connect(), fixture.connect()])
  assert.equal((await postJson(fixture.initUrl, { entries: [{ key: 'response-one', initial: 'stale seed' }] })).status, 200)
  await waitFor(() => [first, second].every(peer => response(peer)?.toString() === 'server baseline\n'), 'disk response was not loaded for both peers')
  response(first).insert(response(first).length, 'browser addition\n')
  await waitFor(() => fs.readFileSync(sourceFile, 'utf8') === 'server baseline\nbrowser addition\n' && response(second)?.toString() === 'server baseline\nbrowser addition\n', 'browser response did not synchronize to disk and peer')
  fs.writeFileSync(sourceFile, 'server baseline\nbrowser addition\nserver addition\n')
  await waitFor(() => [first, second].every(peer => response(peer)?.toString() === 'server baseline\nbrowser addition\nserver addition\n'), 'server-only modification did not reach both peers')
})

const readResponseFiles = directory => {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? readResponseFiles(filename) : entry.name.endsWith('.md') ? [fs.readFileSync(filename, 'utf8')] : []
  })
}

test('offline browser response and conflicting server edit survive reconnection', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuttal-offline-sync-'))
  const sourceFile = path.join(sourceRoot, 'rebuttal', 'responses', 'response-one.md')
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true })
  fs.writeFileSync(sourceFile, 'original answer\n')
  const fixture = await setup(t, sourceRoot)
  const [offline, connected] = await Promise.all([fixture.connect(), fixture.connect()])
  assert.equal((await postJson(fixture.initUrl, { entries: [{ key: 'response-one', initial: 'stale seed' }] })).status, 200)
  await waitFor(() => [offline, connected].every(peer => response(peer)?.toString() === 'original answer\n'), 'response baseline was not synchronized')
  offline.provider.disconnect()
  const draft = response(offline)
  offline.document.transact(() => {
    draft.delete(0, draft.length)
    draft.insert(0, 'offline peer draft\n')
  })
  fs.writeFileSync(sourceFile, 'server-only draft\n')
  await waitFor(() => response(connected)?.toString() === 'server-only draft\n', 'server edit did not reach the connected peer')
  offline.provider.connect()
  await waitFor(() => offline.provider.synced && response(offline)?.toString() === response(connected)?.toString(), 'reconnected peers did not converge')
  await waitFor(() => {
    const preserved = [response(offline).toString(), ...readResponseFiles(path.join(sourceRoot, 'rebuttal'))].join('\n')
    return preserved.includes('offline peer draft') && preserved.includes('server-only draft')
  }, 'a conflicting browser or server response was lost instead of preserved')
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), response(offline).toString())
})
