#!/usr/bin/env node

'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const WebSocket = require('ws')
const { docs, setupWSConnection } = require('y-websocket/bin/utils')

const DEFAULT_ROOM_PATTERN = /^paper-workspace:[A-Za-z0-9.-]+(?::[0-9]{1,5})?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

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
    maxRooms: positiveInteger(overrides.maxRooms ?? process.env.COLLAB_MAX_ROOMS, 64),
    persistenceDir: overrides.persistenceDir ?? process.env.YPERSISTENCE ?? '',
    maxStorageBytes: positiveInteger(overrides.maxStorageBytes ?? process.env.COLLAB_MAX_STORAGE_BYTES, 512 * 1024 * 1024),
    storageCheckMs: positiveInteger(overrides.storageCheckMs ?? process.env.COLLAB_STORAGE_CHECK_MS, 5000)
  }
  config.allowedProjectSlugs = overrides.allowedProjectSlugs || projectSlugs(
    process.env.COLLAB_PROJECT_CATALOG,
    process.env.COLLAB_DEFAULT_PROJECT_MANIFEST
  )

  const countsByIp = new Map()
  const countsByRoom = new Map()
  const ownedDocNames = new Set()
  let storageBytes = directoryBytes(config.persistenceDir)
  let storageQuotaExceeded = storageBytes >= config.maxStorageBytes

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
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
  })

  const wss = new WebSocket.Server({
    clientTracking: true,
    maxPayload: config.maxPayloadBytes,
    noServer: true,
    perMessageDeflate: false
  })

  wss.on('connection', (socket, request, connection) => {
    const { address, docName, room } = connection
    ownedDocNames.add(docName)
    countsByIp.set(address, (countsByIp.get(address) || 0) + 1)
    countsByRoom.set(room, (countsByRoom.get(room) || 0) + 1)
    socket.on('close', () => {
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
    setupWSConnection(socket, request, { docName })
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
    for (const docName of ownedDocNames) {
      const doc = docs.get(docName)
      if (doc) doc.destroy()
      docs.delete(docName)
    }
    ownedDocNames.clear()
  }

  return { close, config, server, wss }
}

if (require.main === module) {
  const instance = createCollaborationServer()
  instance.server.listen(instance.config.port, instance.config.host, () => {
    console.log(`collaboration server listening on ${instance.config.host}:${instance.config.port}`)
  })
}

module.exports = {
  DEFAULT_ROOM_PATTERN,
  createCollaborationServer,
  directoryBytes,
  projectSlugs,
  requestAddress,
  requestRoom
}
