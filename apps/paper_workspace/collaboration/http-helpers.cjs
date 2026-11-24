'use strict'

const fs = require('node:fs')

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

const projectSlugAllowed = (config, slug) => {
  if (config.allowedProjectSlugs.has(slug)) return true
  if (!config.reloadProjectSlugs) return false
  const refreshed = projectSlugs(config.projectCatalogPath, config.defaultProjectManifestPath)
  config.allowedProjectSlugs = refreshed
  return refreshed.has(slug)
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
  request.on('aborted', () => reject(new Error('runtime sync request aborted')))
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


module.exports = { DEFAULT_ROOM_PATTERN, positiveInteger, configuredOrigins, projectSlugs, projectSlugAllowed, defaultProjectSlugs, requestRoom, runtimeSyncRoom, roomHost, requestAddress, rejectUpgrade, readJsonBody, jsonResponse }
