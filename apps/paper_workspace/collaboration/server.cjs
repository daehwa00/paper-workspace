#!/usr/bin/env node

'use strict'

const http = require('http')
const path = require('path')
const WebSocket = require('ws')
const Y = require('yjs')
const decoding = require('lib0/decoding')
const { docs, getPersistence, getYDoc, setupWSConnection } = require('y-websocket/bin/utils')
const { createRebuttalSourceSync } = require('./rebuttal-sources.cjs')

const PERSISTENCE_READINESS = Symbol.for('paper-workspace.persistence-readiness')
const {
  DEFAULT_ROOM_PATTERN, positiveInteger, configuredOrigins, projectSlugs, projectSlugAllowed,
  defaultProjectSlugs, requestRoom, runtimeSyncRoom, roomHost, requestAddress, rejectUpgrade, readJsonBody, jsonResponse
} = require('./http-helpers.cjs')
const {
  sourceFingerprint, runtimeSyncPayload, readRuntimeProject, applyRuntimeSources, createRuntimeSync, createRoomMetadata
} = require('./runtime-sync.cjs')
const { readLiveManagedSources, loadSourceHistories, saveSourceHistories, writeBackManagedSources, createWriteback } = require('./writeback.cjs')
const { directoryBytes, monitorStorageQuota } = require('./storage-quota.cjs')
const awarenessOwnershipTracked = new WeakSet()

function trackAwarenessOwnership(document) {
  if (awarenessOwnershipTracked.has(document)) return
  awarenessOwnershipTracked.add(document)
  document.awareness.on('update', ({ updated }, connection) => {
    const controlled = document.conns.get(connection)
    if (!controlled) return
    // Reappearing IDs are reported as updates while the departure clock remains.
    // Reclaim only unowned IDs; relaying a live peer must not transfer ownership.
    for (const clientId of updated) {
      if (!document.awareness.getStates().has(clientId)) continue
      let owned = false
      for (const ids of document.conns.values()) if (ids.has(clientId)) { owned = true; break }
      if (!owned) controlled.add(clientId)
    }
  })
}

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
    sourceWritebackDebounceMs: positiveInteger(overrides.sourceWritebackDebounceMs ?? process.env.COLLAB_SOURCE_WRITEBACK_DEBOUNCE_MS, 350),
    rebuttalSourcePollMs: positiveInteger(overrides.rebuttalSourcePollMs ?? process.env.COLLAB_REBUTTAL_SOURCE_POLL_MS, 1000),
    maxDocumentBytes: positiveInteger(overrides.maxDocumentBytes ?? process.env.COLLAB_MAX_DOCUMENT_BYTES, 32 * 1024 * 1024),
    maxRooms: positiveInteger(overrides.maxRooms ?? process.env.COLLAB_MAX_ROOMS, 64),
    projectRuntimeDir: overrides.projectRuntimeDir ?? process.env.COLLAB_PROJECT_RUNTIME ?? '',
    defaultProjectSourceDir: overrides.defaultProjectSourceDir ?? process.env.COLLAB_DEFAULT_PROJECT_SOURCE ?? '',
    projectsSourceDir: overrides.projectsSourceDir ?? process.env.COLLAB_PROJECTS_SOURCE ?? '',
    persistenceDir: overrides.persistenceDir ?? process.env.YPERSISTENCE ?? '',
    sourceHistoryDir: overrides.sourceHistoryDir ?? process.env.COLLAB_SOURCE_HISTORY_DIR ?? '',
    maxStorageBytes: positiveInteger(overrides.maxStorageBytes ?? process.env.COLLAB_MAX_STORAGE_BYTES, 512 * 1024 * 1024),
    storageCheckMs: positiveInteger(overrides.storageCheckMs ?? process.env.COLLAB_STORAGE_CHECK_MS, 5000)
  }
  config.projectCatalogPath = process.env.COLLAB_PROJECT_CATALOG
  config.defaultProjectManifestPath = process.env.COLLAB_DEFAULT_PROJECT_MANIFEST
  config.reloadProjectSlugs = !overrides.allowedProjectSlugs
  config.allowedProjectSlugs = overrides.allowedProjectSlugs || projectSlugs(
    config.projectCatalogPath,
    config.defaultProjectManifestPath
  )
  config.defaultProjectSlugs = overrides.defaultProjectSlugs || defaultProjectSlugs(
    process.env.COLLAB_PROJECT_CATALOG,
    process.env.COLLAB_DEFAULT_PROJECT_MANIFEST
  )
  if (!config.sourceHistoryDir && config.persistenceDir) config.sourceHistoryDir = path.join(path.dirname(config.persistenceDir), 'source-history')
  if (config.sourceHistoryDir && !path.isAbsolute(config.sourceHistoryDir)) throw new Error('source history directory must be absolute')

  const roomMetadata = createRoomMetadata(config)
  const countsByIp = new Map()
  const countsByRoom = new Map()
  const runtimeSyncQueues = new Map()
  const runtimeRequestsByIp = new Map()
  const activeRuntimeRequests = new Set()
  const httpSockets = new Set()
  const rebuttalSourceStates = new Map()
  const ownedDocNames = new Set()

  const queueRuntimeSync = (room, operation) => {
    const previous = runtimeSyncQueues.get(room) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    runtimeSyncQueues.set(room, current)
    current.finally(() => {
      if (runtimeSyncQueues.get(room) === current) runtimeSyncQueues.delete(room)
    }).catch(() => {})
    return current
  }

  const sourceRootForSlug = slug => {
    const root = config.defaultProjectSlugs.has(slug)
      ? config.defaultProjectSourceDir
      : config.projectsSourceDir && path.join(config.projectsSourceDir, slug)
    return root && path.isAbsolute(root) ? root : ''
  }

  const ensureRebuttalSources = (docName, room, document) => {
    const previous = rebuttalSourceStates.get(docName)
    if (previous?.document === document) return previous.sync
    previous?.sync.close()
    const projectRoot = sourceRootForSlug(room.slice(room.lastIndexOf(':') + 1))
    if (!projectRoot) return null
    const sync = createRebuttalSourceSync({document, projectRoot, pollMs: config.rebuttalSourcePollMs, maxBytes: config.maxRuntimeSyncBytes, maxDocumentBytes: config.maxDocumentBytes})
    const entry = {document, sync}
    rebuttalSourceStates.set(docName, entry)
    document.once('destroy', () => {
      sync.close()
      if (rebuttalSourceStates.get(docName) === entry) rebuttalSourceStates.delete(docName)
    })
    return sync
  }

  const { ensureSourceWriteback, refreshWritebackBaseline, scheduleSourceWriteback, closeWriteback } =
    createWriteback({ config, sourceRootForSlug, roomMetadata })
  const handleRuntimeSync = createRuntimeSync({
    config, docs, ownedDocNames, queueRuntimeSync, prepareCollaborationDocument,
    ensureSourceWriteback, refreshWritebackBaseline, scheduleSourceWriteback,
    runtimeRequestsByIp, quotaExceeded: () => quota.exceeded(), persistence, roomMetadata
  })

  const handleTextInit = async (request, response, room, manuscript) => {
    const origin = String(request.headers.origin || '')
    let host = ''
    try { host = new URL(origin).host } catch {}
    if (!config.allowedOrigins.has(origin) || host !== roomHost(room)) return jsonResponse(response, 403, {error: 'origin not allowed'})
    if (!String(request.headers['x-paper-actor'] || '').trim()) return jsonResponse(response, 401, {error: 'authenticated actor required'})
    if (!['owner', 'editor'].includes(request.headers['x-paper-role'])) return jsonResponse(response, 403, {error: 'editor role required'})
    const slug = room.slice(room.lastIndexOf(':') + 1)
    if (!projectSlugAllowed(config, slug) || !request.headers['x-paper-allowed-projects']) return jsonResponse(response, 404, {error: 'project not allowed'})
    if (quota.exceeded()) return jsonResponse(response, 507, {error: 'storage quota exceeded'})
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return jsonResponse(response, 415, {error: 'JSON required'})
    let data, vector
    const validKey = manuscript
      ? key => typeof key === 'string' && key.length <= 1024 && !/[\\\u0000-\u001f]/.test(key) &&
        key.split('/').every(part => part && part !== '.' && part !== '..')
      : key => typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,239}$/.test(key)
    const seedLimit = manuscript ? config.maxRuntimeSyncBytes : 2_000_000
    try {
      data = await readJsonBody(request, config.maxRuntimeSyncBytes)
      if (!data || !Array.isArray(data.entries) || !data.entries.length || data.entries.length > 64) throw new Error('invalid response entries')
      const keys = new Set()
      for (const entry of data.entries) {
        if (!validKey(entry?.key) || typeof entry.initial !== 'string' || Buffer.byteLength(entry.initial) > seedLimit || keys.has(entry.key)) {
          throw new Error('invalid shared text seed')
        }
        keys.add(entry.key)
      }
      if (data.state_vector !== undefined) {
        if (typeof data.state_vector !== 'string' || data.state_vector.length > 200_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.state_vector)) throw new Error('invalid state vector')
        vector = Buffer.from(data.state_vector, 'base64')
        Y.decodeStateVector(vector)
      }
    } catch (error) { return jsonResponse(response, error.statusCode || 400, {error: error.message}) }
    await queueRuntimeSync(room, async () => {
      const docName = `collab/${room}`
      const document = docs.get(docName)
      if (!document) return jsonResponse(response, 409, {error: 'collaboration room is not open'})
      await (document.paperPersistenceReady || Promise.resolve())
      if (document.isDestroyed || docs.get(docName) !== document) return jsonResponse(response, 409, {error: 'collaboration room changed; reconnect before initializing responses'})
      const map = document.getMap(manuscript ? 'files' : 'rebuttalResponses')
      if (data.entries.some(entry => map.has(entry.key) && !(map.get(entry.key) instanceof Y.Text))) return jsonResponse(response, 409, {error: 'response is not a shared text'})
      const growth = data.entries.filter(entry => !map.has(entry.key)).reduce((bytes, entry) => bytes + Buffer.byteLength(entry.initial) + 512, 0)
      if (Y.encodeStateAsUpdate(document).byteLength + growth > config.maxDocumentBytes) return jsonResponse(response, 413, {error: 'document size limit exceeded'})
      const sources = manuscript ? null : ensureRebuttalSources(docName, room, document)
      if (sources) sources.ensureTexts(data.entries)
      else document.transact(() => {
        for (const {key, initial} of data.entries) if (!map.has(key)) map.set(key, new Y.Text(initial))
      }, manuscript ? 'file-initialization' : 'response-initialization')
      document.paperDocumentBytes = Y.encodeStateAsUpdate(document).byteLength
      if (persistence?.provider) await persistence.provider.flushDocument(docName)
      jsonResponse(response, 200, {initialized: true, update: Buffer.from(Y.encodeStateAsUpdate(document, vector)).toString('base64')})
    })
  }

  // Compare against the authoritative document in the same event-loop turn as
  // the replacement. A client-side check cannot detect an in-flight peer edit.
  const handleResponseRestore = async (request, response, room) => {
    const origin = String(request.headers.origin || '')
    let host = ''
    try { host = new URL(origin).host } catch {}
    if (!config.allowedOrigins.has(origin) || host !== roomHost(room)) return jsonResponse(response, 403, { error: 'origin not allowed' })
    const actor = String(request.headers['x-paper-actor'] || '').trim()
    const role = request.headers['x-paper-role']
    if (!actor) return jsonResponse(response, 401, { error: 'authenticated actor required' })
    if (role !== 'owner' && role !== 'editor') return jsonResponse(response, 403, { error: 'editor role required' })
    const slug = room.slice(room.lastIndexOf(':') + 1)
    // The trusted proxy authorizes this room and sets a project-scoped role.
    if (!projectSlugAllowed(config, slug) || !request.headers['x-paper-allowed-projects']) return jsonResponse(response, 404, { error: 'project not allowed' })
    if (quota.exceeded()) return jsonResponse(response, 507, { error: 'storage quota exceeded' })
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return jsonResponse(response, 415, { error: 'JSON required' })
    let data
    try { data = await readJsonBody(request, 4_100_000) } catch (error) { return jsonResponse(response, error.statusCode || 400, { error: error.message }) }
    if (!data || typeof data.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,239}$/.test(data.key) || typeof data.expected !== 'string' || typeof data.replacement !== 'string' || Buffer.byteLength(data.expected) > 2_000_000 || Buffer.byteLength(data.replacement) > 2_000_000) return jsonResponse(response, 400, { error: 'invalid response restore' })
    const docName = `collab/${room}`
    const document = docs.get(docName)
    if (!document) return jsonResponse(response, 409, { error: 'collaboration room is not open' })
    const shared = document.getMap('rebuttalResponses').get(data.key)
    if (!(shared instanceof Y.Text)) return jsonResponse(response, 404, { error: 'response not found' })
    if (shared.toString() !== data.expected) return jsonResponse(response, 409, { error: 'response changed' })
    if (Y.encodeStateAsUpdate(document).byteLength + Buffer.byteLength(data.replacement) > config.maxDocumentBytes) return jsonResponse(response, 413, { error: 'document size limit exceeded' })
    document.transact(() => {
      if (shared.length) shared.delete(0, shared.length)
      if (data.replacement) shared.insert(0, data.replacement)
    }, 'response-version-restore')
    document.paperDocumentBytes = Y.encodeStateAsUpdate(document).byteLength
    try {
      if (persistence?.provider) await persistence.provider.flushDocument(docName)
    } catch (error) {
      console.error(`response restore persistence failed (${room}): ${error.message}`)
      return jsonResponse(response, 503, { error: 'Restore may have applied but persistence failed; check the current response.' })
    }
    jsonResponse(response, 200, { restored: true })
  }

  const server = http.createServer(async (request, response) => {
    await quota.ready
    if (request.method === 'GET' && (request.url === '/' || request.url === '/health')) {
      const healthy = !quota.exceeded()
      response.writeHead(healthy ? 200 : 507, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      })
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'storage-quota-exceeded' }))
      return
    }
    const runtimeRoom = runtimeSyncRoom(request)
    const query = runtimeRoom && new URL(request.url, 'http://collaboration.invalid').searchParams
    const manuscript = query?.get('file-init') === '1'
    if (request.method === 'POST' && runtimeRoom && (manuscript || query.get('response-init') === '1')) {
      const operation = handleTextInit(request, response, runtimeRoom, manuscript).catch(error => {
        console.error(`shared text initialization failed: ${error.message}`)
        if (!response.headersSent) jsonResponse(response, 503, {error: 'Shared text initialization unavailable; existing drafts are preserved.'})
        else response.destroy()
      })
      activeRuntimeRequests.add(operation)
      operation.finally(() => activeRuntimeRequests.delete(operation)).catch(() => {})
      return
    }
    if (request.method === 'POST' && runtimeRoom && query.get('response-restore') === '1') {
      const operation = handleResponseRestore(request, response, runtimeRoom).catch(error => {
        console.error(`response restoration failed: ${error.message}`)
        if (!response.headersSent) jsonResponse(response, 500, { error: 'response restoration failed' })
        else response.destroy()
      })
      activeRuntimeRequests.add(operation)
      operation.finally(() => activeRuntimeRequests.delete(operation)).catch(() => {})
      return
    }
    if (request.method === 'POST' && runtimeRoom) {
      const operation = handleRuntimeSync(request, response, runtimeRoom).catch(error => {
        console.error(`runtime synchronization request failed: ${error.message}`)
        if (!response.headersSent) jsonResponse(response, 500, { error: 'runtime synchronization failed' })
        else response.destroy()
      })
      activeRuntimeRequests.add(operation)
      operation.finally(() => activeRuntimeRequests.delete(operation)).catch(() => {})
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
  })
  server.on('connection', socket => {
    httpSockets.add(socket)
    socket.once('close', () => httpSockets.delete(socket))
  })

  const wss = new WebSocket.Server({
    clientTracking: true,
    maxPayload: config.maxPayloadBytes,
    noServer: true,
    perMessageDeflate: false
  })

  wss.on('connection', async (socket, request, connection) => {
    const { address, docName, room } = connection
    const transport = socket._socket
    transport?.pause?.()
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
      roomMetadata(document, docName)
      ensureRebuttalSources(docName, room, document)
      // A source-file problem must not prevent access to healthy persisted edits.
      // Leave writeback disabled until a later connection can initialize it safely.
      try {
        ensureSourceWriteback(docName, room, document)
        const status = document.getMap('project').get('sourceWritebackStatus')
        if (status?.reason === 'initialization') document.getMap('project').delete('sourceWritebackStatus')
      } catch (error) {
        document.getMap('project').set('sourceWritebackStatus', {
          paths: [], state: 'error', reason: 'initialization', timestamp: Date.now()
        })
        console.error(`source writeback initialization unavailable (${room}): ${error.message}`)
      }
      if (socket.readyState !== WebSocket.OPEN) return
      if (!Number.isSafeInteger(document.paperDocumentBytes)) document.paperDocumentBytes = Y.encodeStateAsUpdate(document).byteLength
      if (document.paperDocumentBytes > config.maxDocumentBytes) {
        socket.close(1009, 'document size limit exceeded')
        return
      }
      const existingMessageListeners = new Set(socket.listeners('message'))
      trackAwarenessOwnership(document)
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
        // Viewers may exchange state vectors and awareness, but never document updates.
        if (request.headers['x-paper-role'] === 'viewer') {
          try {
            const decoder = decoding.createDecoder(new Uint8Array(message))
            const kind = decoding.readVarUint(decoder)
            if (kind === 0 && decoding.readVarUint(decoder) !== 0) return
            if (kind !== 0 && kind !== 1 && kind !== 3) return
          } catch { return }
        }
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
    } finally {
      transport?.resume?.()
    }
  })

  server.on('upgrade', async (request, socket, head) => {
    await quota.ready
    if (socket.destroyed) return
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
    if (!projectSlugAllowed(config, slug)) {
      rejectUpgrade(socket, '404 Not Found', 'project not allowed')
      return
    }
    if (quota.exceeded()) {
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

  const quota = monitorStorageQuota({
    root: config.persistenceDir,
    limit: config.maxStorageBytes,
    interval: config.storageCheckMs,
    onExceeded: () => {
      for (const socket of wss.clients) socket.close(1013, 'storage quota exceeded')
    },
    onCheck: () => {
      const expiredBefore = Date.now() - 120_000
      for (const [address, rate] of runtimeRequestsByIp) if (rate.startedAt < expiredBefore) runtimeRequestsByIp.delete(address)
    }
  })

  const closeHttpServer = () => new Promise((resolve, reject) => {
    if (!server.listening) return resolve()
    const forceCloseTimer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      else for (const socket of httpSockets) socket.destroy()
    }, 1000)
    forceCloseTimer.unref()
    const done = error => {
      clearTimeout(forceCloseTimer)
      if (error) reject(error)
      else resolve()
    }
    server.close(done)
  })

  const close = async () => {
    quota.close()
    for (const {sync} of rebuttalSourceStates.values()) sync.close()
    rebuttalSourceStates.clear()
    closeWriteback()
    for (const socket of wss.clients) socket.terminate()
    const websocketClosed = new Promise((resolve, reject) => {
      wss.close(error => error ? reject(error) : resolve())
    })
    const httpClosed = closeHttpServer()
    await Promise.all([websocketClosed, httpClosed])
    await Promise.allSettled([...activeRuntimeRequests])
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
    activeRuntimeRequests.clear()
    httpSockets.clear()
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
  loadSourceHistories,
  projectSlugs,
  projectSlugAllowed,
  prepareCollaborationDocument,
  readRuntimeProject,
  readLiveManagedSources,
  messageDocumentGrowthBytes,
  requestAddress,
  requestRoom,
  runtimeSyncPayload,
  runtimeSyncRoom,
  saveSourceHistories,
  sourceFingerprint,
  writeBackManagedSources,
  roomHost
}
