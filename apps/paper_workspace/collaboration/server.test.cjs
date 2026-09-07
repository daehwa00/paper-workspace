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
const { applyRuntimeSources, createCollaborationServer, loadSourceHistories, messageDocumentGrowthBytes, prepareCollaborationDocument, projectSlugAllowed, readRuntimeProject, requestRoom, roomHost, runtimeSyncRoom, sourceFingerprint, writeBackManagedSources } = require('./server.cjs')
const { mergeTextHistory, mergeTextVersions } = require('./source-merge.cjs')
const { docs, getYDoc } = require('y-websocket/bin/utils')

const listen = instance => new Promise(resolve => {
  instance.server.listen(0, '127.0.0.1', () => resolve(instance.server.address().port))
})

const waitFor = (predicate, message, timeoutMs = 2000) => new Promise((resolve, reject) => {
  const started = Date.now()
  const poll = () => {
    if (predicate()) return resolve()
    if (Date.now() - started > timeoutMs) return reject(new Error(message))
    setTimeout(poll, 10)
  }
  poll()
})

const waitForProviderSync = provider => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('test collaboration client did not synchronize')), 2000)
  provider.once('sync', synchronized => {
    if (!synchronized) return
    clearTimeout(timeout)
    resolve()
  })
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

const writeSourceProject = (root, source, locked = false) => {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'main.tex'), source)
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({
    entrypoint: 'main.tex',
    files: [{ path: 'main.tex', managed: true, ...(locked ? { locked: true } : {}) }]
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

test('project allowlist reloads when a new catalog project is requested', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-collab-catalog-'))
  const catalog = path.join(root, 'projects.json')
  fs.writeFileSync(catalog, JSON.stringify({ projects: [{ slug: 'existing-paper' }] }))
  const config = {
    allowedProjectSlugs: new Set(['default', 'existing-paper']),
    defaultProjectManifestPath: '',
    projectCatalogPath: catalog,
    reloadProjectSlugs: true
  }

  assert.equal(projectSlugAllowed(config, 'new-paper'), false)
  fs.writeFileSync(catalog, JSON.stringify({ projects: [{ slug: 'existing-paper' }, { slug: 'new-paper' }] }))
  assert.equal(projectSlugAllowed(config, 'new-paper'), true)
  assert.equal(config.allowedProjectSlugs.has('existing-paper'), true)
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

test('three-way text merge combines independent web and server edits', () => {
  const base = 'title: old\nabstract: old\nmethod: stable\n'
  const web = 'title: old\nabstract: edited in browser\nmethod: stable\n'
  const server = 'title: edited locally\nabstract: old\nmethod: stable\n'
  assert.deepEqual(mergeTextVersions(base, web, server), {
    conflict: false,
    value: 'title: edited locally\nabstract: edited in browser\nmethod: stable\n'
  })
})

test('three-way text merge combines independent edits within one LaTeX line', () => {
  const base = '\\title{Old title} % keep this submission note\n'
  const web = '\\title{Browser title} % keep this submission note\n'
  const server = '\\title{Old title} % retain this submission note\n'
  assert.deepEqual(mergeTextVersions(base, web, server), {
    conflict: false,
    value: '\\title{Browser title} % retain this submission note\n'
  })
})

test('three-way text merge refuses overlapping edits', () => {
  const base = 'abstract: old\n'
  const web = 'abstract: edited in browser\n'
  const server = 'abstract: edited locally\n'
  assert.equal(mergeTextVersions(base, web, server).conflict, true)
})

test('three-way text merge refuses different insertions at the same character position', () => {
  const base = '\\title{Paper}\n'
  const web = '\\title{Browser Paper}\n'
  const server = '\\title{Local Paper}\n'
  assert.equal(mergeTextVersions(base, web, server).conflict, true)
})

test('history merge does not bless a stale local overwrite when base costs tie', () => {
  const base = 'abstract: old\n'
  const web = 'abstract: edited in browser\n'
  const server = 'abstract: edited locally\n'
  const result = mergeTextHistory([base, web], web, server)
  assert.equal(result.conflict, true)
  assert.equal(result.base, base)
})

test('runtime source conflicts activate the local source and preserve the web manuscript', () => {
  const document = new Y.Doc()
  const files = document.getMap('files')
  const project = document.getMap('project')
  const main = new Y.Text()
  main.insert(0, 'abstract: edited in browser\n')
  files.set('paper/main.tex', main)
  project.set('serverRuntimeRevision', 'a'.repeat(64))
  project.set('serverSourceFingerprints', { 'paper/main.tex': sourceFingerprint('abstract: old\n') })

  const result = applyRuntimeSources(document, {
    previousRuntimeRevision: 'a'.repeat(64),
    retiredPaths: [],
    runtimeRevision: 'b'.repeat(64),
    sources: { 'paper/main.tex': 'abstract: edited locally\n' },
    version: '1'
  }, 1234, null, {
    'paper/main.tex': ['abstract: old\n']
  })

  assert.equal(files.get('paper/main.tex').toString(), 'abstract: edited locally\n')
  assert.deepEqual(result.protected_paths, [])
  assert.deepEqual(result.conflict_paths, ['paper/main.tex'])
  assert.equal(result.preserved_paths.length, 1)
  assert.match(result.preserved_paths[0], /^paper\/drafts\/web-conflict-/)
  assert.equal(files.get(result.preserved_paths[0]).toString(), 'abstract: edited in browser\n')
  document.destroy()
})

test('runtime source application reports automatically merged paths separately', () => {
  const document = new Y.Doc()
  const main = new Y.Text()
  main.insert(0, 'title: old\nabstract: edited in browser\n')
  document.getMap('files').set('paper/main.tex', main)
  document.getMap('project').set('serverRuntimeRevision', 'a'.repeat(64))
  const result = applyRuntimeSources(document, {
    previousRuntimeRevision: 'a'.repeat(64),
    retiredPaths: [],
    runtimeRevision: 'b'.repeat(64),
    sources: { 'paper/main.tex': 'title: edited locally\nabstract: old\n' },
    version: '1'
  }, 1234, null, {
    'paper/main.tex': ['title: old\nabstract: old\n']
  })
  assert.deepEqual(result.merged_paths, ['paper/main.tex'])
  assert.deepEqual(result.conflict_paths, [])
  assert.deepEqual(result.preserved_paths, [])
  assert.equal(main.toString(), 'title: edited locally\nabstract: edited in browser\n')
  document.destroy()
})

test('restoring a deleted local source uses the exact previous server version as the merge base', () => {
  const document = new Y.Doc()
  const files = document.getMap('files')
  const project = document.getMap('project')
  const main = new Y.Text()
  main.insert(0, '')
  files.set('paper/supplement.tex', main)
  project.set('serverRuntimeRevision', 'a'.repeat(64))
  project.set('serverSourceFingerprints', {
    'paper/supplement.tex': sourceFingerprint('')
  })
  const restored = '\\documentclass{article}\n\\input{sections/appendix/index}\n'

  const result = applyRuntimeSources(document, {
    previousRuntimeRevision: 'a'.repeat(64),
    retiredPaths: [],
    runtimeRevision: 'b'.repeat(64),
    sources: { 'paper/supplement.tex': restored },
    version: '1'
  }, 1234, null, {
    'paper/supplement.tex': [restored, '']
  })

  assert.equal(files.get('paper/supplement.tex').toString(), restored)
  assert.deepEqual(result.conflict_paths, [])
  assert.deepEqual(result.merged_paths, [])
  assert.deepEqual(result.preserved_paths, [])
  document.destroy()
})

test('managed source writeback follows web edits but refuses to overwrite an external edit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-source-writeback-'))
  try {
    writeSourceProject(root, 'server baseline')
    const document = new Y.Doc()
    const text = new Y.Text()
    text.insert(0, 'server baseline')
    document.getMap('files').set('paper/main.tex', text)
    const state = new Map()
    writeBackManagedSources(document, root, state)

    text.insert(text.length, '\nfirst web edit')
    const first = writeBackManagedSources(document, root, state)
    assert.deepEqual(first.writtenPaths, ['paper/main.tex'])
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'server baseline\nfirst web edit')

    text.insert(text.length, '\nsecond web edit')
    const second = writeBackManagedSources(document, root, state)
    assert.deepEqual(second.writtenPaths, ['paper/main.tex'])
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'server baseline\nfirst web edit\nsecond web edit')

    fs.writeFileSync(path.join(root, 'main.tex'), 'external server edit')
    text.insert(text.length, '\nthird web edit')
    const conflict = writeBackManagedSources(document, root, state)
    assert.deepEqual(conflict.conflictPaths, ['paper/main.tex'])
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'external server edit')
    document.destroy()
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('manifest text extensions marked as assets remain synchronized sources', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-text-asset-source-'))
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-text-asset-runtime-'))
  try {
    const mainSource = '\\documentclass{article}\\n'
    const claimsSource = '\\newcommand{\\Claim}{initial}\\n'
    const files = [
      { path: 'main.tex', managed: true },
      { path: 'generated/claims.tex', type: 'asset', managed: true }
    ]
    fs.mkdirSync(path.join(sourceRoot, 'generated'), { recursive: true })
    fs.writeFileSync(path.join(sourceRoot, 'main.tex'), mainSource)
    fs.writeFileSync(path.join(sourceRoot, 'generated/claims.tex'), claimsSource)
    fs.writeFileSync(path.join(sourceRoot, 'project.json'), JSON.stringify({ entrypoint: 'main.tex', files }))

    const runtimeProject = path.join(runtimeRoot, 'projects', 'example-paper')
    fs.mkdirSync(path.join(runtimeProject, 'generated'), { recursive: true })
    fs.writeFileSync(path.join(runtimeProject, 'main.tex'), mainSource)
    fs.writeFileSync(path.join(runtimeProject, 'generated/claims.tex'), claimsSource)
    const revision = 'b'.repeat(64)
    fs.writeFileSync(path.join(runtimeProject, 'project.json'), JSON.stringify({
      entrypoint: 'main.tex',
      files,
      runtime_file_revisions: {
        'main.tex': crypto.createHash('sha256').update(mainSource).digest('hex'),
        'generated/claims.tex': crypto.createHash('sha256').update(claimsSource).digest('hex')
      },
      runtime_revision: revision,
      version: '1'
    }))

    const runtime = readRuntimeProject(runtimeRoot, 'example-paper', revision, 1024 * 1024)
    assert.deepEqual(runtime.sources, {
      'paper/main.tex': mainSource,
      'paper/generated/claims.tex': claimsSource
    })

    const document = new Y.Doc()
    const claims = new Y.Text()
    claims.insert(0, claimsSource)
    document.getMap('files').set('paper/generated/claims.tex', claims)
    const expectedDigests = new Map()
    writeBackManagedSources(document, sourceRoot, expectedDigests)
    claims.insert(claims.length, '\\newcommand{\\ClaimStatus}{updated}\\n')

    const result = writeBackManagedSources(document, sourceRoot, expectedDigests)
    assert.deepEqual(result, { conflictPaths: [], writtenPaths: ['paper/generated/claims.tex'] })
    assert.equal(fs.readFileSync(path.join(sourceRoot, 'generated/claims.tex'), 'utf8'), claims.toString())
    document.destroy()
  } finally {
    fs.rmSync(sourceRoot, { force: true, recursive: true })
    fs.rmSync(runtimeRoot, { force: true, recursive: true })
  }
})

test('locked managed sources reject stale browser writes and restore the disk value', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-source-lock-'))
  try {
    writeSourceProject(root, 'protected main source', true)
    const document = new Y.Doc()
    const text = new Y.Text()
    text.insert(0, 'stale browser overwrite')
    document.getMap('files').set('paper/main.tex', text)

    const result = writeBackManagedSources(document, root, new Map())

    assert.deepEqual(result.writtenPaths, [])
    assert.deepEqual(result.conflictPaths, [])
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'protected main source')
    assert.equal(text.toString(), 'protected main source')
    document.destroy()
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('locked managed sources restore a deleted shared source from disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-source-lock-deleted-'))
  try {
    writeSourceProject(root, 'protected main source', true)
    const document = new Y.Doc()
    const files = document.getMap('files')

    const result = writeBackManagedSources(document, root, new Map())

    assert.deepEqual(result.writtenPaths, [])
    assert.deepEqual(result.conflictPaths, [])
    assert.ok(files.get('paper/main.tex') instanceof Y.Text)
    assert.equal(files.get('paper/main.tex').toString(), 'protected main source')
    document.destroy()
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('locked managed sources replace a non-text shared value from disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-source-lock-malformed-'))
  try {
    writeSourceProject(root, 'protected main source', true)
    const document = new Y.Doc()
    const files = document.getMap('files')
    files.set('paper/main.tex', new Y.Map())

    const result = writeBackManagedSources(document, root, new Map())

    assert.deepEqual(result.writtenPaths, [])
    assert.deepEqual(result.conflictPaths, [])
    assert.ok(files.get('paper/main.tex') instanceof Y.Text)
    assert.equal(files.get('paper/main.tex').toString(), 'protected main source')
    document.destroy()
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('runtime source locks preserve a divergent browser value as a draft', () => {
  const document = new Y.Doc()
  const files = document.getMap('files')
  const project = document.getMap('project')
  const main = new Y.Text()
  main.insert(0, 'browser value before lock')
  files.set('paper/main.tex', main)
  project.set('serverRuntimeRevision', 'a'.repeat(64))

  const result = applyRuntimeSources(document, {
    lockedPaths: ['paper/main.tex'],
    previousRuntimeRevision: 'a'.repeat(64),
    retiredPaths: [],
    runtimeRevision: 'b'.repeat(64),
    sources: { 'paper/main.tex': 'protected server value' },
    version: '1'
  }, 1234)

  assert.equal(main.toString(), 'protected server value')
  assert.equal(result.preserved_paths.length, 1)
  assert.match(result.preserved_paths[0], /^paper\/drafts\/locked-web-edit-/)
  assert.equal(files.get(result.preserved_paths[0]).toString(), 'browser value before lock')
  document.destroy()
})

test('a stale staged runtime revision waits for the newer source to be staged', () => {
  const document = new Y.Doc()
  const files = document.getMap('files')
  const project = document.getMap('project')
  const main = new Y.Text()
  main.insert(0, 'newer web source already written to disk')
  files.set('paper/main.tex', main)
  project.set('serverRuntimeRevision', 'a'.repeat(64))
  project.set('serverSourceFingerprints', { 'paper/main.tex': sourceFingerprint('old server source') })

  const result = applyRuntimeSources(document, {
    previousRuntimeRevision: 'a'.repeat(64),
    retiredPaths: [],
    runtimeRevision: 'b'.repeat(64),
    sources: { 'paper/main.tex': 'older staged web source' },
    version: '1'
  }, 1234, {
    'paper/main.tex': 'newer web source already written to disk'
  })

  assert.equal(result.conflict, true)
  assert.deepEqual(result.live_source_conflict_paths, ['paper/main.tex'])
  assert.equal(files.get('paper/main.tex').toString(), 'newer web source already written to disk')
  assert.equal(project.get('serverRuntimeRevision'), 'a'.repeat(64))
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

test('connected Yjs edits are written back to the authoritative project source', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-connected-writeback-'))
  const sourceHistoryDir = path.join(sourceRoot, '.source-history')
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }))
  writeSourceProject(sourceRoot, 'server baseline')
  const room = 'paper-workspace:paper.example:example-paper'
  const docName = `collab/${room}`
  const document = getYDoc(docName)
  const main = new Y.Text()
  main.insert(0, 'server baseline\nexisting web edit')
  document.getMap('files').set('paper/main.tex', main)
  document.getMap('project').set('serverSourceFingerprints', {
    'paper/main.tex': sourceFingerprint('server baseline')
  })
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    defaultProjectSlugs: new Set(['example-paper']),
    defaultProjectSourceDir: sourceRoot,
    sourceHistoryDir,
    sourceWritebackDebounceMs: 10
  })
  t.after(() => instance.close())
  const port = await listen(instance)
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

  await new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8') === 'server baseline\nexisting web edit') return resolve()
      if (Date.now() - started > 2000) return reject(new Error('existing web edit was not written back'))
      setTimeout(poll, 10)
    }
    poll()
  })

  const clientMain = clientDocument.getMap('files').get('paper/main.tex')
  clientMain.insert(clientMain.length, '\nnew web edit')
  await new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8') === 'server baseline\nexisting web edit\nnew web edit') return resolve()
      if (Date.now() - started > 2000) return reject(new Error('web edit was not written back'))
      setTimeout(poll, 10)
    }
    poll()
  })
  assert.deepEqual(document.getMap('project').get('sourceWritebackStatus'), {
    paths: ['paper/main.tex'],
    state: 'synced',
    timestamp: document.getMap('project').get('sourceWritebackStatus').timestamp
  })
  const persistedHistory = loadSourceHistories(sourceHistoryDir, docName)
  assert.equal(persistedHistory['paper/main.tex'].at(-1), 'server baseline\nexisting web edit\nnew web edit')
})

test('missing managed source entries do not prevent an authenticated collaboration connection', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-missing-managed-source-'))
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }))
  writeSourceProject(sourceRoot, 'server baseline')
  const manifestPath = path.join(sourceRoot, 'project.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.files.push({ path: 'optional.tex', managed: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    defaultProjectSlugs: new Set(['example-paper']),
    defaultProjectSourceDir: sourceRoot
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const clientDocument = new Y.Doc()
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, 'paper-workspace:paper.example:example-paper', clientDocument, {
    WebSocketPolyfill: PaperOriginWebSocket,
    disableBc: true
  })
  t.after(() => { provider.destroy(); clientDocument.destroy() })

  await waitForProviderSync(provider)
})

test('disconnecting flushes a pending managed-source writeback when Yjs disposes the document', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-writeback-disconnect-'))
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }))
  writeSourceProject(sourceRoot, 'server baseline')
  const room = 'paper-workspace:paper.example:example-paper'
  const docName = `collab/${room}`
  const document = getYDoc(docName)
  const main = new Y.Text()
  main.insert(0, 'server baseline')
  document.getMap('files').set('paper/main.tex', main)
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    defaultProjectSlugs: new Set(['example-paper']),
    defaultProjectSourceDir: sourceRoot,
    sourceWritebackDebounceMs: 1000
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const clientDocument = new Y.Doc()
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, room, clientDocument, {
    WebSocketPolyfill: PaperOriginWebSocket,
    disableBc: true
  })
  t.after(() => { provider.destroy(); clientDocument.destroy() })
  await waitForProviderSync(provider)

  const clientMain = clientDocument.getMap('files').get('paper/main.tex')
  clientMain.insert(clientMain.length, '\nlast web edit')
  await waitFor(
    () => document.getMap('files').get('paper/main.tex')?.toString() === 'server baseline\nlast web edit',
    'server did not receive the final web edit'
  )

  const closed = new Promise(resolve => provider.ws.once('close', resolve))
  provider.destroy()
  await closed
  docs.delete(docName)
  document.destroy()

  assert.equal(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), 'server baseline\nlast web edit')
})

test('reconnecting after Yjs replaces a document rebinds managed-source writeback', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-writeback-reconnect-'))
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }))
  writeSourceProject(sourceRoot, 'server baseline')
  const room = 'paper-workspace:paper.example:example-paper'
  const docName = `collab/${room}`
  const firstDocument = getYDoc(docName)
  const firstMain = new Y.Text()
  firstMain.insert(0, 'server baseline')
  firstDocument.getMap('files').set('paper/main.tex', firstMain)
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    defaultProjectSlugs: new Set(['example-paper']),
    defaultProjectSourceDir: sourceRoot,
    sourceWritebackDebounceMs: 10
  })
  t.after(() => instance.close())
  const port = await listen(instance)
  const firstClient = new Y.Doc()
  const firstProvider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, room, firstClient, {
    WebSocketPolyfill: PaperOriginWebSocket,
    disableBc: true
  })
  t.after(() => { firstProvider.destroy(); firstClient.destroy() })
  await waitForProviderSync(firstProvider)

  const persistedUpdate = Y.encodeStateAsUpdate(firstDocument)
  const firstClosed = new Promise(resolve => firstProvider.ws.once('close', resolve))
  firstProvider.destroy()
  await firstClosed
  docs.delete(docName)
  firstDocument.destroy()
  const secondDocument = getYDoc(docName)
  Y.applyUpdate(secondDocument, persistedUpdate)

  const secondClient = new Y.Doc()
  const secondProvider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, room, secondClient, {
    WebSocketPolyfill: PaperOriginWebSocket,
    disableBc: true
  })
  t.after(() => { secondProvider.destroy(); secondClient.destroy() })
  await waitForProviderSync(secondProvider)
  const secondMain = new Y.Text()
  secondMain.insert(0, 'reconnected web edit')
  secondClient.getMap('files').set('paper/main.tex', secondMain)

  await waitFor(
    () => fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8') === 'reconnected web edit',
    'reconnected web edit was not written back'
  )
  assert.equal(docs.get(docName), secondDocument)
  assert.notEqual(secondDocument, firstDocument)
})

test('an overlapping local save stays authoritative while the web manuscript is preserved', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-stale-local-source-'))
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-stale-local-runtime-'))
  const sourceHistoryDir = path.join(sourceRoot, '.source-history')
  t.after(() => {
    fs.rmSync(sourceRoot, { force: true, recursive: true })
    fs.rmSync(runtimeRoot, { force: true, recursive: true })
  })
  const base = 'abstract: old\n'
  const web = 'abstract: edited in browser\n'
  const staleLocal = 'abstract: edited by stale local tool\n'
  writeSourceProject(sourceRoot, base)
  const room = 'paper-workspace:paper.example:example-paper'
  const docName = `collab/${room}`
  const document = getYDoc(docName)
  const main = new Y.Text()
  main.insert(0, web)
  document.getMap('files').set('paper/main.tex', main)
  document.getMap('project').set('serverRuntimeRevision', 'a'.repeat(64))
  document.getMap('project').set('serverSourceFingerprints', {
    'paper/main.tex': sourceFingerprint(base)
  })
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper']),
    defaultProjectSlugs: new Set(['example-paper']),
    defaultProjectSourceDir: sourceRoot,
    projectRuntimeDir: runtimeRoot,
    sourceHistoryDir,
    sourceWritebackDebounceMs: 10
  })
  t.after(() => instance.close())
  const port = await listen(instance)
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
  await new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8') === web) return resolve()
      if (Date.now() - started > 2000) return reject(new Error('web baseline was not written back'))
      setTimeout(poll, 10)
    }
    poll()
  })

  fs.writeFileSync(path.join(sourceRoot, 'main.tex'), staleLocal)
  const runtimeRevision = 'b'.repeat(64)
  writeRuntimeProject(runtimeRoot, { revision: runtimeRevision, source: staleLocal })
  fs.renameSync(path.join(runtimeRoot, 'projects/example-paper'), path.join(runtimeRoot, 'project'))
  const response = await postJson(
    `http://127.0.0.1:${port}/collab-runtime/${encodeURIComponent(room)}`,
    { previous_runtime_revision: 'a'.repeat(64), runtime_revision: runtimeRevision }
  )
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.protected_paths, [])
  assert.deepEqual(response.body.conflict_paths, ['paper/main.tex'])
  assert.equal(document.getMap('files').get('paper/main.tex').toString(), staleLocal)
  const conflictDrafts = [...document.getMap('files').entries()]
    .filter(([name]) => name.startsWith('paper/drafts/web-conflict-'))
  assert.equal(conflictDrafts.length, 1)
  assert.equal(conflictDrafts[0][1].toString(), web)
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), staleLocal)
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

test('shutdown force-closes an incomplete runtime request before clearing collaboration documents', async t => {
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper'])
  })
  let closed = false
  let partialRequest
  let provider
  let clientDocument
  t.after(async () => {
    partialRequest?.destroy()
    provider?.destroy()
    clientDocument?.destroy()
    if (!closed) await instance.close()
  })
  const port = await listen(instance)
  const room = 'paper-workspace:paper.example:example-paper'
  const docName = `collab/${room}`
  clientDocument = new Y.Doc()
  provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, room, clientDocument, {
    WebSocketPolyfill: PaperOriginWebSocket,
    disableBc: true
  })
  await waitForProviderSync(provider)
  partialRequest = http.request({
    method: 'POST',
    hostname: '127.0.0.1',
    port,
    path: `/collab-runtime/${encodeURIComponent(room)}`,
    headers: {
      'Content-Length': '64',
      'Content-Type': 'application/json',
      Origin: 'https://paper.example',
      'X-Paper-Actor': 'test-user'
    }
  })
  partialRequest.on('error', () => {})
  partialRequest.write('{')
  await new Promise(resolve => setTimeout(resolve, 20))

  const started = Date.now()
  const shutdown = instance.close()
  let timeout
  try {
    await Promise.race([
      shutdown,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('server shutdown waited for an incomplete runtime request')), 2000)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
  closed = true
  assert.ok(Date.now() - started < 1500)
  assert.equal(docs.has(docName), false)
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

test('a delayed persistence read preserves the provider initial synchronization message', async t => {
  const instance = createCollaborationServer({
    allowedOrigins: new Set(['https://paper.example']),
    allowedProjectSlugs: new Set(['example-paper'])
  })
  const room = 'paper-workspace:paper.example:example-paper'
  const docName = `collab/${room}`
  const document = getYDoc(docName)
  let releasePersistence
  document.paperPersistenceReady = new Promise(resolve => { releasePersistence = resolve })
  const clientDocument = new Y.Doc()
  let provider
  t.after(async () => {
    releasePersistence()
    provider?.destroy()
    clientDocument.destroy()
    await instance.close()
  })
  const port = await listen(instance)
  provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, room, clientDocument, {
    WebSocketPolyfill: PaperOriginWebSocket,
    disableBc: true
  })

  await new Promise(resolve => setTimeout(resolve, 20))
  releasePersistence()
  await waitForProviderSync(provider)
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
