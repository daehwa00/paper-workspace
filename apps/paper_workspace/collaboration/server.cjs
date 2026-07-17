#!/usr/bin/env node

'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const WebSocket = require('ws')
const Y = require('yjs')
const decoding = require('lib0/decoding')
const { docs, getPersistence, getYDoc, setupWSConnection } = require('y-websocket/bin/utils')

const DEFAULT_ROOM_PATTERN = /^paper-workspace:[A-Za-z0-9.-]+(?::[0-9]{1,5})?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const RUNTIME_REVISION_PATTERN = /^[0-9a-f]{64}$/
const PERSISTENCE_READINESS = Symbol.for('paper-workspace.persistence-readiness')

const persistence = getPersistence()
if (persistence && !persistence[PERSISTENCE_READINESS]) {
  const bindState = persistence.bindState.bind(persistence)
  persistence.bindState = (docName, document) => {
    const ready = Promise.resolve().then(() => bindState(docName, document))
    document.paperPersistenceReady = ready
    return ready
  }
  persistence[PERSISTENCE_READINESS] = true
}

const prepareCollaborationDocument = async docName => {
  const document = getYDoc(docName)
  await (document.paperPersistenceReady || Promise.resolve())
  return document
}

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const configuredOrigins = value => new Set(
  String(value || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
)

const projectSlugs = (catalogPath, defaultManifestPath) => {
  const slugs = new Set(['default'])
  const readJson = filename => {
    if (!filename) return null
    try {
      return JSON.parse(fs.readFileSync(filename, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  const catalog = readJson(catalogPath)
  for (const project of catalog?.projects || []) {
    if (typeof project?.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(project.slug)) {
      slugs.add(project.slug)
    }
  }
  const defaultManifest = readJson(defaultManifestPath)
  if (typeof defaultManifest?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(defaultManifest.id)) {
    slugs.add(defaultManifest.id)
  }
  return slugs
}

const defaultProjectSlugs = (catalogPath, defaultManifestPath) => {
  const slugs = new Set(['default'])
  const readJson = filename => {
    if (!filename) return null
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  const defaultManifest = readJson(defaultManifestPath)
  if (typeof defaultManifest?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(defaultManifest.id)) slugs.add(defaultManifest.id)
  const catalog = readJson(catalogPath)
  for (const project of catalog?.projects || []) {
    if (project?.source === 'default' && typeof project.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(project.slug)) slugs.add(project.slug)
  }
  return slugs
}

const requestRoom = request => {
  try {
    const pathname = new URL(request.url || '/', 'http://collaboration.invalid').pathname
    const prefix = '/collab/'
    if (!pathname.startsWith(prefix)) return null
    const room = decodeURIComponent(pathname.slice(prefix.length))
    return DEFAULT_ROOM_PATTERN.test(room) ? room : null
  } catch {
    return null
  }
}

const runtimeSyncRoom = request => {
  try {
    const pathname = new URL(request.url || '/', 'http://collaboration.invalid').pathname
    const prefix = '/collab-runtime/'
    if (!pathname.startsWith(prefix)) return null
    const room = decodeURIComponent(pathname.slice(prefix.length))
    return DEFAULT_ROOM_PATTERN.test(room) ? room : null
  } catch {
    return null
  }
}

const roomHost = room => {
  const prefix = 'paper-workspace:'
  const slugSeparator = room.lastIndexOf(':')
  return room.startsWith(prefix) && slugSeparator > prefix.length
    ? room.slice(prefix.length, slugSeparator)
    : ''
}

const messageDocumentGrowthBytes = message => {
  try {
    const bytes = new Uint8Array(message)
    const decoder = decoding.createDecoder(bytes)
    if (decoding.readVarUint(decoder) !== 0) return 0
    const syncMessageType = decoding.readVarUint(decoder)
    return syncMessageType === 1 || syncMessageType === 2 ? bytes.byteLength : 0
  } catch {
    return 0
  }
}

const requestAddress = (request, trustProxy) => {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    if (forwarded.length) return forwarded[forwarded.length - 1]
  }
  return request.socket.remoteAddress || 'unknown'
}

const directoryBytes = root => {
  if (!root) return 0
  let total = 0
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) {
        try {
          total += fs.statSync(entryPath).size
        } catch (error) {
          // LevelDB atomically replaces manifests and table files during
          // compaction. A file seen by readdir may legitimately disappear
          // before stat without making the database unavailable.
          if (error.code !== 'ENOENT') throw error
        }
      }
    }
  }
  return total
}

const rejectUpgrade = (socket, status, message) => {
  const body = `${message}\n`
  socket.end(
    `HTTP/1.1 ${status}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
    body
  )
}

const validProjectPath = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.startsWith('/') && !value.includes('\\') && value.split('/').length <= 12 && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && ![...part].some(character => character.charCodeAt(0) < 32))

const sourceFingerprint = value => {
  let first = 2166136261
  let second = 2246822507
  const source = String(value ?? '')
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 3266489917)
  }
  return `fp1:${source.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`
}

const replaceSharedText = (text, value) => {
  const current = text.toString()
  if (current === value) return
  let prefix = 0
  while (prefix < current.length && prefix < value.length && current[prefix] === value[prefix]) prefix += 1
  let suffix = 0
  while (suffix < current.length - prefix && suffix < value.length - prefix && current[current.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix += 1
  const removed = current.length - prefix - suffix
  if (removed) text.delete(prefix, removed)
  const inserted = value.slice(prefix, value.length - suffix)
  if (inserted) text.insert(prefix, inserted)
}

const runtimeSyncPayload = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid runtime sync payload')
  const runtimeRevision = String(value.runtime_revision || '')
  const previousRuntimeRevision = String(value.previous_runtime_revision || '')
  if (!RUNTIME_REVISION_PATTERN.test(runtimeRevision) || !RUNTIME_REVISION_PATTERN.test(previousRuntimeRevision)) throw new Error('invalid runtime revision')
  return { previousRuntimeRevision, runtimeRevision }
}

const checkedRuntimeFile = (root, relativePath, maxBytes) => {
  if (!root || !validProjectPath(relativePath)) throw new Error('invalid runtime project path')
  let current = root
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid runtime project root')
  for (const part of relativePath.split('/')) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('runtime project symlinks are not allowed')
  }
  const stat = fs.statSync(current)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid runtime project file')
  return { filename: current, size: stat.size }
}

const readRuntimeProject = (runtimeRoot, slug, expectedRevision, maxBytes, defaultSlugs = new Set(['default'])) => {
  if (!path.isAbsolute(runtimeRoot)) throw new Error('project runtime is unavailable')
  const projectRoot = defaultSlugs.has(slug)
    ? path.join(runtimeRoot, 'project')
    : path.join(runtimeRoot, 'projects', slug)
  const manifestFile = checkedRuntimeFile(projectRoot, 'project.json', Math.min(maxBytes, 2 * 1024 * 1024))
  const manifest = JSON.parse(fs.readFileSync(manifestFile.filename, 'utf8'))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid runtime project manifest')
  if (String(manifest.runtime_revision || '') !== expectedRevision) {
    const error = new Error('runtime revision is no longer available')
    error.statusCode = 409
    throw error
  }
  if (typeof manifest.version !== 'string' || manifest.version.length < 1 || manifest.version.length > 160) throw new Error('invalid runtime project version')
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 240) throw new Error('invalid runtime project files')
  const entrypoint = manifest.entrypoint || 'main.tex'
  if (!validProjectPath(entrypoint)) throw new Error('invalid runtime project entrypoint')
  const revisions = manifest.runtime_file_revisions
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) throw new Error('runtime file revisions are missing')
  const sources = {}
  let totalBytes = manifestFile.size
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || !validProjectPath(item.path)) throw new Error('invalid runtime project file entry')
    if (item.type === 'asset' || (!item.managed && item.path !== entrypoint)) continue
    const sourcePath = item.source || item.path
    if (!validProjectPath(sourcePath)) throw new Error('invalid runtime project source path')
    if (item.path === 'drafts' || item.path.startsWith('drafts/') || sourcePath === 'drafts' || sourcePath.startsWith('drafts/')) throw new Error('drafts cannot be authoritative runtime sources')
    const sourceFile = checkedRuntimeFile(projectRoot, sourcePath, maxBytes)
    totalBytes += sourceFile.size
    if (totalBytes > maxBytes) throw new Error('runtime project sources exceed their size limit')
    const bytes = fs.readFileSync(sourceFile.filename)
    const expectedFileRevision = String(revisions[sourcePath] || '')
    const actualFileRevision = crypto.createHash('sha256').update(bytes).digest('hex')
    if (!RUNTIME_REVISION_PATTERN.test(expectedFileRevision) || actualFileRevision !== expectedFileRevision) {
      const error = new Error('runtime project changed while being read')
      error.statusCode = 409
      throw error
    }
    sources[`paper/${item.path}`] = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  if (!Object.keys(sources).length) throw new Error('runtime project has no managed sources')
  const retiredPaths = Array.isArray(manifest.retired_paths) ? manifest.retired_paths : []
  if (retiredPaths.length > 240 || retiredPaths.some(sourcePath => !validProjectPath(sourcePath))) throw new Error('invalid retired runtime source path')
  return {
    retiredPaths: [...new Set(retiredPaths.map(sourcePath => `paper/${sourcePath}`))],
    runtimeRevision: expectedRevision,
    sources,
    version: manifest.version
  }
}

const nextServerDraftPath = (files, sourcePath, timestamp, startIndex) => {
  const safeName = path.posix.basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_') || 'source.tex'
  let index = startIndex
  let candidate
  do {
    candidate = `paper/drafts/server-before-sync-${timestamp}-${index}-${safeName}`
    index += 1
  } while (files.has(candidate))
  return { path: candidate, nextIndex: index }
}

const applyRuntimeSources = (document, payload, timestamp = Date.now()) => {
  const project = document.getMap('project')
  const files = document.getMap('files')
  const currentRevision = String(project.get('serverRuntimeRevision') || '')
  if (currentRevision === payload.runtimeRevision) return { current_revision: currentRevision, deduplicated: true, preserved_paths: [] }
  if (currentRevision !== payload.previousRuntimeRevision) return { conflict: true, current_revision: currentRevision }
  const previousFingerprintsValue = project.get('serverSourceFingerprints')
  const previousFingerprints = previousFingerprintsValue && typeof previousFingerprintsValue === 'object' && !Array.isArray(previousFingerprintsValue) ? previousFingerprintsValue : {}
  const nextPaths = new Set(Object.keys(payload.sources))
  const removedPaths = payload.retiredPaths.filter(sourcePath => !nextPaths.has(sourcePath))
  const preservedPaths = []
  let draftIndex = 0
  document.transact(() => {
    for (const sourcePath of removedPaths) {
      const current = files.get(sourcePath)?.toString?.()
      if (typeof current === 'string' && current) {
        const draft = nextServerDraftPath(files, sourcePath, timestamp, draftIndex)
        draftIndex = draft.nextIndex
        let draftText = files.get(draft.path)
        if (!(draftText instanceof Y.Text)) { draftText = new Y.Text(); files.set(draft.path, draftText) }
        replaceSharedText(draftText, current)
        preservedPaths.push(draft.path)
      }
      files.delete(sourcePath)
    }
    const nextFingerprints = {}
    for (const [sourcePath, source] of Object.entries(payload.sources)) {
      let text = files.get(sourcePath)
      if (!(text instanceof Y.Text)) { text = new Y.Text(); files.set(sourcePath, text) }
      const current = text.toString()
      const previousFingerprint = previousFingerprints[sourcePath]
      if (current !== source && current && (!previousFingerprint || sourceFingerprint(current) !== previousFingerprint)) {
        const draft = nextServerDraftPath(files, sourcePath, timestamp, draftIndex)
        draftIndex = draft.nextIndex
        let draftText = files.get(draft.path)
        if (!(draftText instanceof Y.Text)) { draftText = new Y.Text(); files.set(draft.path, draftText) }
        replaceSharedText(draftText, current)
        preservedPaths.push(draft.path)
      }
      replaceSharedText(text, source)
      nextFingerprints[sourcePath] = sourceFingerprint(source)
    }
    project.set('manifestVersion', payload.version)
    project.set('serverRuntimeRevision', payload.runtimeRevision)
    project.set('serverManagedPaths', [...nextPaths])
    project.set('serverSourceFingerprints', nextFingerprints)
  }, 'server-runtime-sync')
  return { current_revision: payload.runtimeRevision, deduplicated: false, preserved_paths: preservedPaths }
}

const readJsonBody = (request, limit) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  let tooLarge = false
  request.on('data', chunk => {
    size += chunk.length
    if (size > limit) tooLarge = true
    else chunks.push(chunk)
  })
  request.on('end', () => {
    if (tooLarge) { const error = new Error('runtime sync payload too large'); error.statusCode = 413; reject(error); return }
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { const error = new Error('invalid JSON payload'); error.statusCode = 400; reject(error) }
  })
  request.on('error', reject)
})

const jsonResponse = (response, status, payload) => {
  const body = Buffer.from(JSON.stringify(payload))
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(body)
}

function createCollaborationServer (overrides = {}) {
  const config = {
    host: overrides.host || process.env.HOST || '127.0.0.1',
    port: positiveInteger(overrides.port ?? process.env.PORT, 8765),
    allowedOrigins: overrides.allowedOrigins || configuredOrigins(process.env.COLLAB_ALLOWED_ORIGINS),
    trustProxy: overrides.trustProxy ?? process.env.COLLAB_TRUST_PROXY === '1',
    maxPayloadBytes: positiveInteger(overrides.maxPayloadBytes ?? process.env.COLLAB_MAX_PAYLOAD_BYTES, 16 * 1024 * 1024),
    maxConnections: positiveInteger(overrides.maxConnections ?? process.env.COLLAB_MAX_CONNECTIONS, 128),
    maxConnectionsPerIp: positiveInteger(overrides.maxConnectionsPerIp ?? process.env.COLLAB_MAX_CONNECTIONS_PER_IP, 16),
    maxConnectionsPerRoom: positiveInteger(overrides.maxConnectionsPerRoom ?? process.env.COLLAB_MAX_CONNECTIONS_PER_ROOM, 32),
    maxConnectionAgeMs: positiveInteger(overrides.maxConnectionAgeMs ?? process.env.COLLAB_MAX_CONNECTION_AGE_MS, 6 * 60 * 60 * 1000),
    maxIngressBytesPerMinute: positiveInteger(overrides.maxIngressBytesPerMinute ?? process.env.COLLAB_MAX_INGRESS_BYTES_PER_MINUTE, 16 * 1024 * 1024),
    maxRuntimeSyncBytes: positiveInteger(overrides.maxRuntimeSyncBytes ?? process.env.COLLAB_MAX_RUNTIME_SYNC_BYTES, 8 * 1024 * 1024),
    maxRuntimeSyncRequestsPerMinute: positiveInteger(overrides.maxRuntimeSyncRequestsPerMinute ?? process.env.COLLAB_MAX_RUNTIME_SYNC_REQUESTS_PER_MINUTE, 60),
    maxDocumentBytes: positiveInteger(overrides.maxDocumentBytes ?? process.env.COLLAB_MAX_DOCUMENT_BYTES, 32 * 1024 * 1024),
    maxRooms: positiveInteger(overrides.maxRooms ?? process.env.COLLAB_MAX_ROOMS, 64),
    projectRuntimeDir: overrides.projectRuntimeDir ?? process.env.COLLAB_PROJECT_RUNTIME ?? '',
    persistenceDir: overrides.persistenceDir ?? process.env.YPERSISTENCE ?? '',
    maxStorageBytes: positiveInteger(overrides.maxStorageBytes ?? process.env.COLLAB_MAX_STORAGE_BYTES, 512 * 1024 * 1024),
    storageCheckMs: positiveInteger(overrides.storageCheckMs ?? process.env.COLLAB_STORAGE_CHECK_MS, 5000)
  }
  config.allowedProjectSlugs = overrides.allowedProjectSlugs || projectSlugs(
    process.env.COLLAB_PROJECT_CATALOG,
    process.env.COLLAB_DEFAULT_PROJECT_MANIFEST
  )
  config.defaultProjectSlugs = overrides.defaultProjectSlugs || defaultProjectSlugs(
    process.env.COLLAB_PROJECT_CATALOG,
    process.env.COLLAB_DEFAULT_PROJECT_MANIFEST
  )

  const countsByIp = new Map()
  const countsByRoom = new Map()
  const runtimeSyncQueues = new Map()
  const runtimeRequestsByIp = new Map()
  const ownedDocNames = new Set()
  let storageBytes = directoryBytes(config.persistenceDir)
  let storageQuotaExceeded = storageBytes >= config.maxStorageBytes

  const queueRuntimeSync = (room, operation) => {
    const previous = runtimeSyncQueues.get(room) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    runtimeSyncQueues.set(room, current)
    current.finally(() => {
      if (runtimeSyncQueues.get(room) === current) runtimeSyncQueues.delete(room)
    }).catch(() => {})
    return current
  }

  const handleRuntimeSync = async (request, response, room) => {
    const origin = String(request.headers.origin || '')
    if (!origin || !config.allowedOrigins.has(origin)) {
      jsonResponse(response, 403, { error: 'origin not allowed' })
      return
    }
    if (!String(request.headers['x-paper-actor'] || '').trim()) {
      jsonResponse(response, 401, { error: 'authenticated actor required' })
      return
    }
    const address = requestAddress(request, config.trustProxy)
    const now = Date.now()
    const previousRate = runtimeRequestsByIp.get(address)
    const rate = !previousRate || now - previousRate.startedAt >= 60_000
      ? { count: 0, startedAt: now }
      : previousRate
    rate.count += 1
    runtimeRequestsByIp.set(address, rate)
    if (rate.count > config.maxRuntimeSyncRequestsPerMinute) {
      request.resume()
      jsonResponse(response, 429, { error: 'runtime synchronization rate limit exceeded' })
      return
    }
    let originHost = ''
    try { originHost = new URL(origin).host } catch {}
    if (!originHost || roomHost(room) !== originHost) {
      jsonResponse(response, 403, { error: 'room host does not match origin' })
      return
    }
    const slug = room.slice(room.lastIndexOf(':') + 1)
    if (!config.allowedProjectSlugs.has(slug)) {
      jsonResponse(response, 404, { error: 'project not allowed' })
      return
    }
    if (storageQuotaExceeded) {
      jsonResponse(response, 507, { error: 'storage quota exceeded' })
      return
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      jsonResponse(response, 415, { error: 'JSON content type required' })
      return
    }
    const signalLimit = 16 * 1024
    const declaredLength = Number.parseInt(String(request.headers['content-length'] || ''), 10)
    if (Number.isFinite(declaredLength) && declaredLength > signalLimit) {
      request.resume()
      jsonResponse(response, 413, { error: 'runtime sync payload too large' })
      return
    }
    let payload
    try {
      payload = runtimeSyncPayload(await readJsonBody(request, signalLimit))
    } catch (error) {
      jsonResponse(response, error.statusCode || 400, { error: error.message })
      return
    }
    try {
      const result = await queueRuntimeSync(room, async () => {
        const docName = `collab/${room}`
        if (!docs.has(docName)) return { error: 'collaboration room is not open', statusCode: 409 }
        const document = await prepareCollaborationDocument(docName)
        ownedDocNames.add(docName)
        const runtimeProject = readRuntimeProject(
          config.projectRuntimeDir,
          slug,
          payload.runtimeRevision,
          config.maxRuntimeSyncBytes,
          config.defaultProjectSlugs
        )
        const update = { ...runtimeProject, previousRuntimeRevision: payload.previousRuntimeRevision }
        const timestamp = Date.now()
        const candidate = new Y.Doc()
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
          const preview = applyRuntimeSources(candidate, update, timestamp)
          if (preview.conflict) return preview
          if (preview.deduplicated) {
            if (persistence?.provider) {
              await persistence.provider.flushDocument(docName)
              const persisted = await persistence.provider.getYDoc(docName)
              try {
                if (!(persisted instanceof Y.Doc) || persisted.getMap('project').get('serverRuntimeRevision') !== update.runtimeRevision) throw new Error('runtime source update was not persisted')
              } finally {
                persisted?.destroy?.()
              }
            }
            return preview
          }
          const candidateBytes = Y.encodeStateAsUpdate(candidate).byteLength
          if (candidateBytes > config.maxDocumentBytes) {
            return { error: 'document size limit exceeded', statusCode: 413 }
          }
        } finally {
          candidate.destroy()
        }
        const applied = applyRuntimeSources(document, update, timestamp)
        document.paperDocumentBytes = Y.encodeStateAsUpdate(document).byteLength
        document.paperPendingGrowthBytes = 0
        if (persistence?.provider) {
          await persistence.provider.flushDocument(docName)
          const persisted = await persistence.provider.getYDoc(docName)
          try {
            if (!(persisted instanceof Y.Doc) || persisted.getMap('project').get('serverRuntimeRevision') !== update.runtimeRevision) {
              throw new Error('runtime source update was not persisted')
            }
          } finally {
            persisted?.destroy?.()
          }
        }
        return applied
      })
      if (result.error) jsonResponse(response, result.statusCode || 500, { error: result.error })
      else if (result.conflict) jsonResponse(response, 409, result)
      else jsonResponse(response, 200, result)
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) console.error(`runtime source synchronization failed (${room}): ${error.message}`)
      jsonResponse(response, error.statusCode || 503, { error: error.statusCode ? error.message : 'collaboration state unavailable' })
    }
  }

  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && (request.url === '/' || request.url === '/health')) {
      const healthy = !storageQuotaExceeded
      response.writeHead(healthy ? 200 : 507, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      })
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'storage-quota-exceeded' }))
      return
    }
    const runtimeRoom = runtimeSyncRoom(request)
    if (request.method === 'POST' && runtimeRoom) {
      handleRuntimeSync(request, response, runtimeRoom).catch(error => {
        console.error(`runtime synchronization request failed: ${error.message}`)
        if (!response.headersSent) jsonResponse(response, 500, { error: 'runtime synchronization failed' })
        else response.destroy()
      })
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
  })

  const wss = new WebSocket.Server({
    clientTracking: true,
    maxPayload: config.maxPayloadBytes,
    noServer: true,
    perMessageDeflate: false
  })

  wss.on('connection', async (socket, request, connection) => {
    const { address, docName, room } = connection
    ownedDocNames.add(docName)
    countsByIp.set(address, (countsByIp.get(address) || 0) + 1)
    countsByRoom.set(room, (countsByRoom.get(room) || 0) + 1)
    const reauthenticationTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.close(4001, 'reauthentication required')
    }, config.maxConnectionAgeMs)
    reauthenticationTimer.unref()
    socket.on('close', () => {
      clearTimeout(reauthenticationTimer)
      const nextIp = (countsByIp.get(address) || 1) - 1
      const nextRoom = (countsByRoom.get(room) || 1) - 1
      if (nextIp > 0) countsByIp.set(address, nextIp); else countsByIp.delete(address)
      if (nextRoom > 0) countsByRoom.set(room, nextRoom); else countsByRoom.delete(room)
    })
    socket.on('error', error => {
      // ws emits protocol and payload-limit failures on the individual socket.
      // Without a listener Node treats them as uncaught errors and restarts the
      // entire collaboration service, disconnecting every healthy room.
      console.warn(`collaboration socket closed (${room}): ${error.code || error.message}`)
    })
    try {
      const document = await prepareCollaborationDocument(docName)
      if (socket.readyState !== WebSocket.OPEN) return
      if (!Number.isSafeInteger(document.paperDocumentBytes)) document.paperDocumentBytes = Y.encodeStateAsUpdate(document).byteLength
      if (document.paperDocumentBytes > config.maxDocumentBytes) {
        socket.close(1009, 'document size limit exceeded')
        return
      }
      const existingMessageListeners = new Set(socket.listeners('message'))
      setupWSConnection(socket, request, { docName })
      const protocolListener = socket.listeners('message').find(listener => !existingMessageListeners.has(listener))
      if (!protocolListener) throw new Error('collaboration protocol listener was not installed')
      socket.removeListener('message', protocolListener)
      let ingressWindowStarted = Date.now()
      let ingressBytes = 0
      socket.on('message', (message, ...args) => {
        const now = Date.now()
        if (now - ingressWindowStarted >= 60_000) {
          ingressWindowStarted = now
          ingressBytes = 0
        }
        ingressBytes += Number(message?.byteLength ?? message?.length ?? 0)
        if (ingressBytes > config.maxIngressBytesPerMinute) {
          socket.close(1009, 'message rate limit exceeded')
          return
        }
        const growthBytes = messageDocumentGrowthBytes(message)
        if (growthBytes && document.paperDocumentBytes + growthBytes > config.maxDocumentBytes) {
          socket.close(1009, 'document size limit exceeded')
          return
        }
        protocolListener(message, ...args)
        if (growthBytes) {
          document.paperDocumentBytes += growthBytes
          document.paperPendingGrowthBytes = (document.paperPendingGrowthBytes || 0) + growthBytes
          if (document.paperPendingGrowthBytes >= 256 * 1024) {
            document.paperDocumentBytes = Y.encodeStateAsUpdate(document).byteLength
            document.paperPendingGrowthBytes = 0
          }
        }
      })
    } catch (error) {
      console.error(`collaboration persistence unavailable (${room}): ${error.message}`)
      socket.close(1011, 'collaboration state unavailable')
    }
  })

  server.on('upgrade', (request, socket, head) => {
    const origin = String(request.headers.origin || '')
    if (!origin || !config.allowedOrigins.has(origin)) {
      rejectUpgrade(socket, '403 Forbidden', 'origin not allowed')
      return
    }
    const room = requestRoom(request)
    if (!room) {
      rejectUpgrade(socket, '404 Not Found', 'room not allowed')
      return
    }
    let originHost = ''
    try { originHost = new URL(origin).host } catch {}
    if (!originHost || roomHost(room) !== originHost) {
      rejectUpgrade(socket, '403 Forbidden', 'room host does not match origin')
      return
    }
    const slug = room.slice(room.lastIndexOf(':') + 1)
    if (!config.allowedProjectSlugs.has(slug)) {
      rejectUpgrade(socket, '404 Not Found', 'project not allowed')
      return
    }
    if (storageQuotaExceeded) {
      rejectUpgrade(socket, '507 Insufficient Storage', 'storage quota exceeded')
      return
    }
    const address = requestAddress(request, config.trustProxy)
    if (wss.clients.size >= config.maxConnections || (countsByIp.get(address) || 0) >= config.maxConnectionsPerIp) {
      rejectUpgrade(socket, '429 Too Many Requests', 'connection limit reached')
      return
    }
    if ((countsByRoom.get(room) || 0) >= config.maxConnectionsPerRoom) {
      rejectUpgrade(socket, '429 Too Many Requests', 'room connection limit reached')
      return
    }
    // Keep the previous y-websocket storage key so the hardening upgrade does
    // not orphan existing LevelDB documents.
    const docName = `collab/${room}`
    if (!docs.has(docName) && docs.size >= config.maxRooms) {
      rejectUpgrade(socket, '429 Too Many Requests', 'room limit reached')
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request, { address, docName, room })
    })
  })

  const quotaTimer = setInterval(() => {
    try {
      const expiredBefore = Date.now() - 120_000
      for (const [address, rate] of runtimeRequestsByIp) if (rate.startedAt < expiredBefore) runtimeRequestsByIp.delete(address)
      storageBytes = directoryBytes(config.persistenceDir)
      storageQuotaExceeded = storageBytes >= config.maxStorageBytes
      if (storageQuotaExceeded) {
        for (const socket of wss.clients) socket.close(1013, 'storage quota exceeded')
      }
    } catch (error) {
      storageQuotaExceeded = true
      console.error('collaboration storage check failed:', error.message)
      for (const socket of wss.clients) socket.close(1011, 'storage unavailable')
    }
  }, config.storageCheckMs)
  quotaTimer.unref()

  const close = async () => {
    clearInterval(quotaTimer)
    for (const socket of wss.clients) socket.terminate()
    const websocketClosed = new Promise((resolve, reject) => {
      wss.close(error => error ? reject(error) : resolve())
    })
    const httpClosed = new Promise((resolve, reject) => {
      if (!server.listening) return resolve()
      server.close(error => error ? reject(error) : resolve())
    })
    await Promise.all([websocketClosed, httpClosed])
    if (persistence?.provider?.flushDocument) {
      await Promise.all([...ownedDocNames].map(docName => persistence.provider.flushDocument(docName)))
    }
    for (const docName of ownedDocNames) {
      const doc = docs.get(docName)
      if (doc) doc.destroy()
      docs.delete(docName)
    }
    ownedDocNames.clear()
    runtimeSyncQueues.clear()
    runtimeRequestsByIp.clear()
  }

  return { close, config, server, wss }
}

if (require.main === module) {
  const instance = createCollaborationServer()
  let shuttingDown = false
  const shutdown = signal => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`collaboration server stopping (${signal})`)
    instance.close()
      .then(() => process.exit(0))
      .catch(error => {
        console.error('collaboration shutdown failed:', error)
        process.exit(1)
      })
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
  instance.server.listen(instance.config.port, instance.config.host, () => {
    console.log(`collaboration server listening on ${instance.config.host}:${instance.config.port}`)
  })
}

module.exports = {
  DEFAULT_ROOM_PATTERN,
  applyRuntimeSources,
  createCollaborationServer,
  defaultProjectSlugs,
  directoryBytes,
  projectSlugs,
  prepareCollaborationDocument,
  readRuntimeProject,
  messageDocumentGrowthBytes,
  requestAddress,
  requestRoom,
  runtimeSyncPayload,
  runtimeSyncRoom,
  sourceFingerprint,
  roomHost
}
