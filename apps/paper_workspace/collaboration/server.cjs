#!/usr/bin/env node

'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const WebSocket = require('ws')
const Y = require('yjs')
const decoding = require('lib0/decoding')
const { docs, getPersistence, getYDoc, setupWSConnection } = require('y-websocket/bin/utils')
const { mergeTextHistory } = require('./source-merge.cjs')

const DEFAULT_ROOM_PATTERN = /^paper-workspace:[A-Za-z0-9.-]+(?::[0-9]{1,5})?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const RUNTIME_REVISION_PATTERN = /^[0-9a-f]{64}$/
const PERSISTENCE_READINESS = Symbol.for('paper-workspace.persistence-readiness')
const SOURCE_HISTORY_VERSIONS = 4
const SOURCE_HISTORY_MAX_BYTES = 16 * 1024 * 1024

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
  const lockedPaths = []
  let totalBytes = manifestFile.size
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || !validProjectPath(item.path)) throw new Error('invalid runtime project file entry')
    if (item.locked !== undefined && typeof item.locked !== 'boolean') throw new Error('invalid runtime project lock')
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
    if (item.locked) lockedPaths.push(`paper/${item.path}`)
  }
  if (!Object.keys(sources).length) throw new Error('runtime project has no managed sources')
  const retiredPaths = Array.isArray(manifest.retired_paths) ? manifest.retired_paths : []
  if (retiredPaths.length > 240 || retiredPaths.some(sourcePath => !validProjectPath(sourcePath))) throw new Error('invalid retired runtime source path')
  return {
    lockedPaths,
    retiredPaths: [...new Set(retiredPaths.map(sourcePath => `paper/${sourcePath}`))],
    runtimeRevision: expectedRevision,
    sources,
    version: manifest.version
  }
}

const managedSourceEntries = (projectRoot, maxBytes) => {
  const manifestFile = checkedRuntimeFile(projectRoot, 'project.json', Math.min(maxBytes, 2 * 1024 * 1024))
  const manifest = JSON.parse(fs.readFileSync(manifestFile.filename, 'utf8'))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid writable project manifest')
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 240) throw new Error('invalid writable project files')
  const entrypoint = manifest.entrypoint || 'main.tex'
  if (!validProjectPath(entrypoint)) throw new Error('invalid writable project entrypoint')
  const entries = []
  let totalBytes = manifestFile.size
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || !validProjectPath(item.path)) throw new Error('invalid writable project file entry')
    if (item.locked !== undefined && typeof item.locked !== 'boolean') throw new Error('invalid writable project lock')
    if (item.type === 'asset' || (!item.managed && item.path !== entrypoint)) continue
    const sourcePath = item.source || item.path
    if (!validProjectPath(sourcePath)) throw new Error('invalid writable project source path')
    if (item.path === 'drafts' || item.path.startsWith('drafts/') || sourcePath === 'drafts' || sourcePath.startsWith('drafts/')) throw new Error('drafts cannot be written to project sources')
    const sourceFile = checkedRuntimeFile(projectRoot, sourcePath, maxBytes)
    totalBytes += sourceFile.size
    if (totalBytes > maxBytes) throw new Error('writable project sources exceed their size limit')
    entries.push({
      filename: sourceFile.filename,
      locked: item.locked === true,
      projectPath: `paper/${item.path}`
    })
  }
  return entries
}

const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const sourceDigest = value => crypto.createHash('sha256').update(value).digest('hex')

const readLiveManagedSources = (projectRoot, maxBytes) => {
  const sources = {}
  for (const entry of managedSourceEntries(projectRoot, maxBytes)) {
    sources[entry.projectPath] = decodeUtf8(fs.readFileSync(entry.filename))
  }
  return sources
}

const atomicReplaceSource = (filename, value, expectedDigest) => {
  const directory = path.dirname(filename)
  const temporary = path.join(directory, `.paper-writeback-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  const original = fs.lstatSync(filename)
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('writable project source is not a regular file')
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', original.mode & 0o777)
    fs.writeFileSync(descriptor, value, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    const current = fs.lstatSync(filename)
    if (!current.isFile() || current.isSymbolicLink() || sourceDigest(fs.readFileSync(filename)) !== expectedDigest) return false
    fs.renameSync(temporary, filename)
    const directoryDescriptor = fs.openSync(directory, 'r')
    try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
    return true
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

const writeBackManagedSources = (document, projectRoot, expectedDigests, requestedPaths = null, maxBytes = 8 * 1024 * 1024) => {
  const files = document.getMap('files')
  const requested = requestedPaths ? new Set(requestedPaths) : null
  const writtenPaths = []
  const conflictPaths = []
  for (const entry of managedSourceEntries(projectRoot, maxBytes)) {
    if (requested && !requested.has(entry.projectPath)) continue
    const currentBytes = fs.readFileSync(entry.filename)
    const current = decodeUtf8(currentBytes)
    const currentDigest = sourceDigest(currentBytes)
    if (entry.locked) {
      let text = files.get(entry.projectPath)
      if (!(text instanceof Y.Text)) {
        text = new Y.Text()
        files.set(entry.projectPath, text)
      }
      replaceSharedText(text, current)
      expectedDigests.set(entry.projectPath, currentDigest)
      continue
    }
    const shared = files.get(entry.projectPath)?.toString?.()
    if (typeof shared !== 'string') continue
    const expectedDigest = expectedDigests.get(entry.projectPath)
    if (shared === current) {
      expectedDigests.set(entry.projectPath, currentDigest)
      continue
    }
    if (!expectedDigest) {
      conflictPaths.push(entry.projectPath)
      continue
    }
    if (currentDigest !== expectedDigest || !atomicReplaceSource(entry.filename, shared, expectedDigest)) {
      conflictPaths.push(entry.projectPath)
      continue
    }
    expectedDigests.set(entry.projectPath, sourceDigest(shared))
    writtenPaths.push(entry.projectPath)
  }
  return { conflictPaths, writtenPaths }
}

const sourceHistoryFilename = (root, docName) => path.join(root, `${crypto.createHash('sha256').update(docName).digest('hex')}.json.gz`)

const loadSourceHistories = (root, docName) => {
  const histories = {}
  if (!root) return histories
  const filename = sourceHistoryFilename(root, docName)
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > SOURCE_HISTORY_MAX_BYTES) throw new Error('source history file exceeds its size limit')
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(filename), {
      maxOutputLength: SOURCE_HISTORY_MAX_BYTES * 2
    }).toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return histories
    let bytes = 0
    for (const [projectPath, versions] of Object.entries(payload.sources || {})) {
      if (!projectPath.startsWith('paper/') || !validProjectPath(projectPath.slice(6)) || !Array.isArray(versions)) continue
      const accepted = versions.filter(value => typeof value === 'string').slice(-SOURCE_HISTORY_VERSIONS)
      bytes += accepted.reduce((total, value) => total + Buffer.byteLength(value), 0)
      if (bytes > SOURCE_HISTORY_MAX_BYTES) break
      if (accepted.length) histories[projectPath] = accepted
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`source history could not be read (${docName}): ${error.message}`)
  }
  return histories
}

const rememberSourceHistory = (histories, projectPath, value) => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > SOURCE_HISTORY_MAX_BYTES / 2) return false
  const versions = Array.isArray(histories[projectPath]) ? histories[projectPath] : []
  if (versions[versions.length - 1] === value) return false
  histories[projectPath] = [...versions, value].slice(-SOURCE_HISTORY_VERSIONS)
  let total = Object.values(histories).flat().reduce((bytes, source) => bytes + Buffer.byteLength(source), 0)
  while (total > SOURCE_HISTORY_MAX_BYTES) {
    const oldest = Object.entries(histories).find(([, sources]) => sources.length > 1)
    if (!oldest) {
      delete histories[projectPath]
      return false
    }
    const [oldestPath, sources] = oldest
    total -= Buffer.byteLength(sources.shift())
    if (!sources.length) delete histories[oldestPath]
  }
  return true
}

const saveSourceHistories = (root, docName, histories) => {
  if (!root) return
  fs.mkdirSync(root, { mode: 0o700, recursive: true })
  const filename = sourceHistoryFilename(root, docName)
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, zlib.gzipSync(JSON.stringify({ sources: histories })), { mode: 0o600 })
    fs.renameSync(temporary, filename)
  } finally {
    try { fs.unlinkSync(temporary) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

const nextServerDraftPath = (files, sourcePath, timestamp, startIndex, prefix = 'server-before-sync') => {
  const safeName = path.posix.basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_') || 'source.tex'
  let index = startIndex
  let candidate
  do {
    candidate = `paper/drafts/${prefix}-${timestamp}-${index}-${safeName}`
    index += 1
  } while (files.has(candidate))
  return { path: candidate, nextIndex: index }
}

const applyRuntimeSources = (document, payload, timestamp = Date.now(), liveSources = null, sourceHistories = null) => {
  const project = document.getMap('project')
  const files = document.getMap('files')
  const currentRevision = String(project.get('serverRuntimeRevision') || '')
  if (currentRevision === payload.runtimeRevision) return { conflict_paths: [], current_revision: currentRevision, deduplicated: true, merged_paths: [], preserved_paths: [], protected_paths: [] }
  if (currentRevision !== payload.previousRuntimeRevision) return { conflict: true, current_revision: currentRevision }
  const previousFingerprintsValue = project.get('serverSourceFingerprints')
  const previousFingerprints = previousFingerprintsValue && typeof previousFingerprintsValue === 'object' && !Array.isArray(previousFingerprintsValue) ? previousFingerprintsValue : {}
  const nextPaths = new Set(Object.keys(payload.sources))
  const liveSourceConflicts = Object.entries(payload.sources)
    .filter(([sourcePath, source]) => typeof liveSources?.[sourcePath] === 'string' && liveSources[sourcePath] !== source)
    .map(([sourcePath]) => sourcePath)
  if (liveSourceConflicts.length) {
    return {
      conflict: true,
      current_revision: currentRevision,
      live_source_conflict_paths: liveSourceConflicts
    }
  }
  const lockedPaths = new Set(payload.lockedPaths || [])
  const removedPaths = payload.retiredPaths.filter(sourcePath => !nextPaths.has(sourcePath))
  const preservedPaths = []
  const protectedPaths = []
  const conflictPaths = []
  const mergedPaths = []
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
      if (lockedPaths.has(sourcePath)) {
        if (current && current !== source) {
          const draft = nextServerDraftPath(files, sourcePath, timestamp, draftIndex, 'locked-web-edit')
          draftIndex = draft.nextIndex
          let draftText = files.get(draft.path)
          if (!(draftText instanceof Y.Text)) { draftText = new Y.Text(); files.set(draft.path, draftText) }
          replaceSharedText(draftText, current)
          preservedPaths.push(draft.path)
        }
        replaceSharedText(text, source)
        nextFingerprints[sourcePath] = sourceFingerprint(source)
        continue
      }
      const previousFingerprint = previousFingerprints[sourcePath]
      const history = sourceHistories?.[sourcePath]
      if (current !== source && Array.isArray(history) && history.length) {
        const exactBase = typeof previousFingerprint === 'string'
          ? history.find(version => sourceFingerprint(version) === previousFingerprint)
          : undefined
        const merged = mergeTextHistory(exactBase === undefined ? history : [exactBase], current, source)
        if (merged.conflict) {
          const draft = nextServerDraftPath(files, sourcePath, timestamp, draftIndex, 'web-conflict')
          draftIndex = draft.nextIndex
          let draftText = files.get(draft.path)
          if (!(draftText instanceof Y.Text)) { draftText = new Y.Text(); files.set(draft.path, draftText) }
          replaceSharedText(draftText, current)
          replaceSharedText(text, source)
          preservedPaths.push(draft.path)
          conflictPaths.push(sourcePath)
          nextFingerprints[sourcePath] = sourceFingerprint(source)
          continue
        }
        replaceSharedText(text, merged.value)
        if (merged.value !== source) {
          protectedPaths.push(sourcePath)
          mergedPaths.push(sourcePath)
        }
        nextFingerprints[sourcePath] = sourceFingerprint(source)
        continue
      }
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
  return {
    conflict_paths: conflictPaths,
    current_revision: payload.runtimeRevision,
    deduplicated: false,
    merged_paths: mergedPaths,
    preserved_paths: preservedPaths,
    protected_paths: protectedPaths
  }
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

  const countsByIp = new Map()
  const countsByRoom = new Map()
  const runtimeSyncQueues = new Map()
  const runtimeRequestsByIp = new Map()
  const activeRuntimeRequests = new Set()
  const httpSockets = new Set()
  const writebackStates = new Map()
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

  const sourceRootForSlug = slug => {
    const root = config.defaultProjectSlugs.has(slug)
      ? config.defaultProjectSourceDir
      : config.projectsSourceDir && path.join(config.projectsSourceDir, slug)
    return root && path.isAbsolute(root) ? root : ''
  }

  const refreshWritebackBaseline = (document, projectRoot, state) => {
    const files = document.getMap('files')
    const projectFingerprints = document.getMap('project').get('serverSourceFingerprints')
    const knownFingerprints = projectFingerprints && typeof projectFingerprints === 'object' && !Array.isArray(projectFingerprints)
      ? projectFingerprints
      : {}
    const liveSources = readLiveManagedSources(projectRoot, config.maxRuntimeSyncBytes)
    const divergentWebPaths = []
    let historyChanged = false
    for (const [projectPath, liveSource] of Object.entries(liveSources)) {
      const sharedSource = files.get(projectPath)?.toString?.()
      if (sharedSource === liveSource) {
        state.expectedDigests.set(projectPath, sourceDigest(liveSource))
        historyChanged = rememberSourceHistory(state.histories, projectPath, liveSource) || historyChanged
      } else if (typeof sharedSource === 'string' && knownFingerprints[projectPath] === sourceFingerprint(liveSource)) {
        // Upgrade an existing room safely: the disk still matches the last
        // server snapshot, so the divergent Yjs value is a connected web edit.
        state.expectedDigests.set(projectPath, sourceDigest(liveSource))
        historyChanged = rememberSourceHistory(state.histories, projectPath, liveSource) || historyChanged
        divergentWebPaths.push(projectPath)
      }
    }
    if (historyChanged) saveSourceHistories(config.sourceHistoryDir, state.docName, state.histories)
    return { divergentWebPaths, liveSources }
  }

  const flushSourceWriteback = state => {
    state.timer = null
    const document = state.document
    if (!document || !state.pendingPaths.size) return
    const requestedPaths = [...state.pendingPaths]
    try {
      const result = writeBackManagedSources(
        document,
        state.projectRoot,
        state.expectedDigests,
        state.pendingPaths,
        config.maxRuntimeSyncBytes
      )
      state.pendingPaths.clear()
      let historyChanged = false
      for (const projectPath of result.writtenPaths) {
        const source = document.getMap('files').get(projectPath)?.toString?.()
        historyChanged = rememberSourceHistory(state.histories, projectPath, source) || historyChanged
      }
      if (historyChanged) saveSourceHistories(config.sourceHistoryDir, state.docName, state.histories)
      document.transact(() => {
        document.getMap('project').set('sourceWritebackStatus', {
          paths: requestedPaths,
          state: result.conflictPaths.length ? 'conflict' : 'synced',
          timestamp: Date.now()
        })
      }, 'server-writeback-status')
      const conflictKey = result.conflictPaths.join('\0')
      if (conflictKey && conflictKey !== state.lastConflictKey) {
        console.warn(`source writeback paused for external changes (${state.docName}): ${result.conflictPaths.join(', ')}`)
      }
      state.lastConflictKey = conflictKey
    } catch (error) {
      document.transact(() => {
        document.getMap('project').set('sourceWritebackStatus', {
          paths: requestedPaths,
          state: 'error',
          timestamp: Date.now()
        })
      }, 'server-writeback-status')
      console.error(`source writeback failed (${state.docName}): ${error.message}`)
    }
  }

  const disposeSourceWriteback = (docName, state, flush) => {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (flush) flushSourceWriteback(state)
    state.files.unobserveDeep(state.observer)
    state.document.off('destroy', state.destroyObserver)
    if (writebackStates.get(docName) === state) writebackStates.delete(docName)
  }

  const scheduleSourceWriteback = state => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => flushSourceWriteback(state), config.sourceWritebackDebounceMs)
    state.timer.unref()
  }

  const ensureSourceWriteback = (docName, room, document) => {
    const previousState = writebackStates.get(docName)
    if (previousState?.document === document) return previousState
    if (previousState) disposeSourceWriteback(docName, previousState, true)
    const projectRoot = sourceRootForSlug(room.slice(room.lastIndexOf(':') + 1))
    if (!projectRoot) return null
    const state = {
      docName,
      document,
      expectedDigests: new Map(),
      histories: loadSourceHistories(config.sourceHistoryDir, docName),
      lastConflictKey: '',
      pendingPaths: new Set(),
      projectRoot,
      timer: null
    }
    const baseline = refreshWritebackBaseline(document, projectRoot, state)
    const files = document.getMap('files')
    state.files = files
    state.observer = (events, transaction) => {
      if (transaction.origin === 'server-runtime-sync') return
      for (const event of events) {
        if (event.target === files) {
          for (const projectPath of event.keysChanged || []) state.pendingPaths.add(projectPath)
          continue
        }
        const projectPath = event.path?.[0]
        if (typeof projectPath === 'string') state.pendingPaths.add(projectPath)
      }
      if (!state.pendingPaths.size) return
      scheduleSourceWriteback(state)
    }
    state.destroyObserver = () => disposeSourceWriteback(docName, state, true)
    files.observeDeep(state.observer)
    document.on('destroy', state.destroyObserver)
    writebackStates.set(docName, state)
    for (const projectPath of baseline.divergentWebPaths) state.pendingPaths.add(projectPath)
    if (state.pendingPaths.size) {
      scheduleSourceWriteback(state)
    }
    return state
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
    if (!projectSlugAllowed(config, slug)) {
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
        const writebackState = ensureSourceWriteback(docName, room, document)
        let liveSources = null
        if (writebackState) {
          liveSources = refreshWritebackBaseline(document, writebackState.projectRoot, writebackState).liveSources
        }
        const update = { ...runtimeProject, previousRuntimeRevision: payload.previousRuntimeRevision }
        const timestamp = Date.now()
        const candidate = new Y.Doc()
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
          const preview = applyRuntimeSources(candidate, update, timestamp, liveSources, writebackState?.histories)
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
        const applied = applyRuntimeSources(document, update, timestamp, liveSources, writebackState?.histories)
        if (writebackState) {
          const baseline = refreshWritebackBaseline(document, writebackState.projectRoot, writebackState)
          for (const projectPath of new Set([...(applied.protected_paths || []), ...baseline.divergentWebPaths])) {
            writebackState.pendingPaths.add(projectPath)
          }
          if (writebackState.pendingPaths.size) {
            scheduleSourceWriteback(writebackState)
          }
        }
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
      ensureSourceWriteback(docName, room, document)
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
    if (!projectSlugAllowed(config, slug)) {
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
    clearInterval(quotaTimer)
    for (const [docName, state] of writebackStates) {
      disposeSourceWriteback(docName, state, true)
    }
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
