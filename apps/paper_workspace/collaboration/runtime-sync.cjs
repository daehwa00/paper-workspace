'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Y = require('yjs')
const { mergeTextHistory } = require('./source-merge.cjs')
const { jsonResponse, readJsonBody, requestAddress, roomHost, projectSlugAllowed } = require('./http-helpers.cjs')

const RUNTIME_REVISION_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_EXTENSIONS = new Set(['tex', 'bib', 'sty', 'bst', 'cls'])

const validProjectPath = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.startsWith('/') && !value.includes('\\') && value.split('/').length <= 12 && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && ![...part].some(character => character.charCodeAt(0) < 32))

const manifestItemIsAsset = item => item.type === 'asset' && !SOURCE_EXTENSIONS.has(path.posix.extname(item.path).slice(1).toLowerCase())

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
  expectedRevision ??= manifest.runtime_revision
  if (!RUNTIME_REVISION_PATTERN.test(expectedRevision) || manifest.runtime_revision !== expectedRevision) {
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
    if (manifestItemIsAsset(item) || (!item.managed && item.path !== entrypoint)) continue
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

const runtimeFields = payload => ({
  manifestVersion: payload.version,
  serverRuntimeRevision: payload.runtimeRevision,
  serverManagedPaths: Object.keys(payload.sources),
  serverSourceFingerprints: Object.fromEntries(Object.entries(payload.sources).map(([key, source]) => [key, sourceFingerprint(source)]))
})

const sourceMetadataKeys = ['serverRuntimeRevision', 'serverManagedPaths', 'serverSourceFingerprints']
const legacyFields = project => {
  const fields = {}
  const revision = project.get('serverRuntimeRevision')
  const version = project.get('manifestVersion')
  const managed = project.get('serverManagedPaths')
  const fingerprints = project.get('serverSourceFingerprints')
  if (typeof revision === 'string' && RUNTIME_REVISION_PATTERN.test(revision)) fields.serverRuntimeRevision = revision
  if (typeof version === 'string' && version.length <= 160) fields.manifestVersion = version
  if (Array.isArray(managed)) fields.serverManagedPaths = managed.filter(key => typeof key === 'string').slice(0, 240)
  if (fingerprints && Object.getPrototypeOf(fingerprints) === Object.prototype) {
    fields.serverSourceFingerprints = Object.fromEntries(Object.entries(fingerprints)
      .filter(([key, value]) => key.startsWith('paper/') && validProjectPath(key.slice(6)) && typeof value === 'string').slice(0, 240))
  }
  return fields
}

const createRoomMetadata = config => {
  const rooms = new Map()
  const attached = new WeakMap()
  const filenameFor = docName => config.sourceHistoryDir && path.join(config.sourceHistoryDir,
    `${crypto.createHash('sha256').update(docName).digest('hex')}.runtime.json`)
  const save = (docName, fields) => {
    const filename = filenameFor(docName)
    if (!filename) return
    fs.mkdirSync(path.dirname(filename), { mode: 0o700, recursive: true })
    const temporary = `${filename}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(fields), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, filename)
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  return (document, docName = document.name) => {
    if (attached.has(document)) return attached.get(document)
    const project = document.getMap('project')
    let state = rooms.get(docName)
    if (!state) {
      let fields
      const filename = filenameFor(docName)
      if (filename) {
        try { fields = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      if (!fields) {
        // Snapshot legacy metadata before this server accepts any socket updates.
        fields = legacyFields(project)
        if (!fields.serverRuntimeRevision && config.projectRuntimeDir) {
          const slug = docName.slice(docName.lastIndexOf(':') + 1)
          try {
            fields = runtimeFields(readRuntimeProject(config.projectRuntimeDir, slug, undefined,
              config.maxRuntimeSyncBytes, config.defaultProjectSlugs))
          } catch (error) {
            if (error.code !== 'ENOENT') console.warn(`runtime metadata initialization unavailable (${docName}): ${error.message}`)
          }
        }
        try { save(docName, fields) } catch (error) {
          console.warn(`runtime metadata could not be saved (${docName}): ${error.message}`)
        }
      }
      state = { fields, pending: null, save: next => save(docName, next) }
      rooms.set(docName, state)
    }
    attached.set(document, state)
    const publish = (includeVersion = false) => document.transact(() => {
      for (const key of includeVersion ? [...sourceMetadataKeys, 'manifestVersion'] : sourceMetadataKeys) {
        const value = state.fields[key]
        if (value === undefined) {
          if (project.has(key)) project.delete(key)
        } else if (JSON.stringify(project.get(key)) !== JSON.stringify(value)) {
          project.set(key, structuredClone(value))
        }
      }
    }, 'server-runtime-metadata')
    state.publish = publish
    project.observe(event => {
      if (event.transaction.origin !== 'server-runtime-metadata' && sourceMetadataKeys.some(key => event.keysChanged.has(key))) publish()
    })
    publish()
    return state
  }
}

const applyRuntimeSources = (document, payload, timestamp = Date.now(), liveSources = null, sourceHistories = null, metadata = null) => {
  const project = document.getMap('project')
  const files = document.getMap('files')
  const fields = metadata || legacyFields(project)
  const currentRevision = String(fields.serverRuntimeRevision || '')
  if (currentRevision === payload.runtimeRevision) return { conflict_paths: [], current_revision: currentRevision, deduplicated: true, merged_paths: [], preserved_paths: [], protected_paths: [] }
  if (currentRevision !== payload.previousRuntimeRevision) return { conflict: true, current_revision: currentRevision }
  const previousFingerprintsValue = fields.serverSourceFingerprints
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
          continue
        }
        replaceSharedText(text, merged.value)
        if (merged.value !== source) {
          protectedPaths.push(sourcePath)
          mergedPaths.push(sourcePath)
        }
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
    }
    if (!metadata) for (const [key, value] of Object.entries(runtimeFields(payload))) project.set(key, value)
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

const createRuntimeSync = ({
  config, docs, ownedDocNames, queueRuntimeSync, prepareCollaborationDocument,
  ensureSourceWriteback, refreshWritebackBaseline, scheduleSourceWriteback,
  runtimeRequestsByIp, quotaExceeded, persistence, roomMetadata
}) => {
  const finishPending = async (document, docName, room, state) => {
    const pending = state.pending
    if (pending.document !== document) {
      Y.applyUpdate(document, pending.update, 'server-runtime-sync')
      pending.document = document
    }
    const writebackState = ensureSourceWriteback(docName, room, document)
    let baseline
    if (writebackState) {
      baseline = refreshWritebackBaseline(document, writebackState.projectRoot, writebackState, pending.fields)
    }
    if (persistence?.provider) {
      await persistence.provider.flushDocument(docName)
      const persisted = await persistence.provider.getYDoc(docName)
      try {
        if (!(persisted instanceof Y.Doc) || !Y.snapshotContainsUpdate(Y.snapshot(persisted), pending.update)) {
          throw new Error('runtime source update was not persisted')
        }
      } finally {
        persisted?.destroy?.()
      }
    }
    state.save(pending.fields)
    state.fields = pending.fields
    state.pending = null
    state.publish(true)
    if (writebackState) {
      for (const projectPath of [...pending.result.protected_paths, ...baseline.divergentWebPaths]) {
        writebackState.pendingPaths.add(projectPath)
      }
      if (writebackState.pendingPaths.size) scheduleSourceWriteback(writebackState)
    }
    return pending.result
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
    if (quotaExceeded()) {
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
        const state = roomMetadata(document, docName)
        if (state.pending) {
          const completed = await finishPending(document, docName, room, state)
          if (completed.current_revision === payload.runtimeRevision) return completed
        }
        const currentRevision = String(state.fields.serverRuntimeRevision || '')
        if (currentRevision === payload.runtimeRevision) {
          return { conflict_paths: [], current_revision: currentRevision, deduplicated: true, merged_paths: [], preserved_paths: [], protected_paths: [] }
        }
        if (currentRevision && currentRevision !== payload.previousRuntimeRevision) return { conflict: true, current_revision: currentRevision }
        const runtimeProject = readRuntimeProject(
          config.projectRuntimeDir, slug, payload.runtimeRevision, config.maxRuntimeSyncBytes, config.defaultProjectSlugs
        )
        const fields = currentRevision
          ? state.fields
          : { ...state.fields, serverRuntimeRevision: payload.previousRuntimeRevision }
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
          const preview = applyRuntimeSources(candidate, update, timestamp, liveSources, writebackState?.histories, fields)
          if (preview.conflict) return preview
          const candidateBytes = Y.encodeStateAsUpdate(candidate).byteLength
          if (candidateBytes > config.maxDocumentBytes) {
            return { error: 'document size limit exceeded', statusCode: 413 }
          }
        } finally {
          candidate.destroy()
        }
        const vector = Y.encodeStateVector(document)
        const applied = applyRuntimeSources(document, update, timestamp, liveSources, writebackState?.histories, fields)
        state.pending = {
          document,
          fields: runtimeFields(update),
          result: applied,
          update: Y.encodeStateAsUpdate(document, vector)
        }
        document.paperDocumentBytes = Y.encodeStateAsUpdate(document).byteLength
        document.paperPendingGrowthBytes = 0
        return finishPending(document, docName, room, state)
      })
      if (result.error) jsonResponse(response, result.statusCode || 500, { error: result.error })
      else if (result.conflict) jsonResponse(response, 409, result)
      else jsonResponse(response, 200, result)
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) console.error(`runtime source synchronization failed (${room}): ${error.message}`)
      jsonResponse(response, error.statusCode || 503, { error: error.statusCode ? error.message : 'collaboration state unavailable' })
    }
  }

  return handleRuntimeSync
}

module.exports = { validProjectPath, manifestItemIsAsset, sourceFingerprint, replaceSharedText, runtimeSyncPayload, checkedRuntimeFile, readRuntimeProject, applyRuntimeSources, nextServerDraftPath, createRuntimeSync, createRoomMetadata }
