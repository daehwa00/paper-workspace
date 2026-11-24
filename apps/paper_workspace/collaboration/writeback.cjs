'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const Y = require('yjs')
const { atomicReplaceSource, readSnapshot, sourceDigest } = require('./atomic-source.cjs')
const { validProjectPath, manifestItemIsAsset, checkedRuntimeFile, replaceSharedText, sourceFingerprint, nextServerDraftPath } = require('./runtime-sync.cjs')

const SOURCE_HISTORY_VERSIONS = 4
const SOURCE_HISTORY_MAX_BYTES = 16 * 1024 * 1024

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
    if (manifestItemIsAsset(item) || (!item.managed && item.path !== entrypoint)) continue
    const sourcePath = item.source || item.path
    if (!validProjectPath(sourcePath)) throw new Error('invalid writable project source path')
    if (item.path === 'drafts' || item.path.startsWith('drafts/') || sourcePath === 'drafts' || sourcePath.startsWith('drafts/')) throw new Error('drafts cannot be written to project sources')
    const entry = { sourcePath, locked: item.locked === true, projectPath: `paper/${item.path}` }
    try {
      const sourceFile = checkedRuntimeFile(projectRoot, sourcePath, maxBytes)
      totalBytes += sourceFile.size
      if (totalBytes > maxBytes) throw new Error('writable project sources exceed their size limit')
      entry.filename = sourceFile.filename
    } catch (error) {
      entry.error = error
    }
    entries.push(entry)
  }
  return entries
}

const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

const readLiveManagedSources = (projectRoot, maxBytes) => {
  const sources = {}
  for (const entry of managedSourceEntries(projectRoot, maxBytes)) {
    try {
      if (entry.error?.code === 'ENOENT') continue
      if (entry.error) throw entry.error
      const snapshot = readSnapshot(entry.filename, maxBytes)
      if (snapshot) sources[entry.projectPath] = decodeUtf8(snapshot.bytes)
    } catch (error) {
      throw new Error(`cannot read managed source ${entry.projectPath}: ${error.message}`, { cause: error })
    }
  }
  return sources
}

const writeBackManagedSources = (document, projectRoot, expectedDigests, requestedPaths = null, maxBytes = 8 * 1024 * 1024) => {
  const files = document.getMap('files')
  const requested = requestedPaths ? new Set(requestedPaths) : null
  const writtenPaths = []
  const conflictPaths = []
  const failures = new Map()
  const recoveries = new Map()
  for (const entry of managedSourceEntries(projectRoot, maxBytes)) {
    const { projectPath, filename } = entry
    if (requested && !requested.has(projectPath)) continue
    try {
      if (entry.error) throw entry.error
      const snapshot = readSnapshot(filename, maxBytes)
      if (!snapshot) throw new Error('managed source is missing')
      const current = decodeUtf8(snapshot.bytes)
      if (entry.locked) {
        let text = files.get(projectPath)
        if (!(text instanceof Y.Text)) {
          text = new Y.Text()
          files.set(projectPath, text)
        }
        replaceSharedText(text, current)
        expectedDigests.set(projectPath, snapshot.digest)
        continue
      }
      const text = files.get(projectPath)
      if (!(text instanceof Y.Text)) continue
      const shared = text.toString()
      if (shared === current) {
        expectedDigests.set(projectPath, snapshot.digest)
        continue
      }
      const expectedDigest = expectedDigests.get(projectPath)
      if (snapshot.digest !== expectedDigest ||
          !atomicReplaceSource(filename, shared, snapshot, maxBytes, Number(snapshot.stat.mode & 0o777n))) {
        conflictPaths.push(projectPath)
        continue
      }
      expectedDigests.set(projectPath, sourceDigest(shared))
      writtenPaths.push(projectPath)
    } catch (error) {
      if (error.recoveryPath) {
        conflictPaths.push(projectPath)
        recoveries.set(projectPath, path.relative(projectRoot, error.recoveryPath))
      } else failures.set(projectPath, error)
    }
  }
  return {
    conflictPaths, writtenPaths,
    ...(failures.size && { failures }),
    ...(recoveries.size && { recoveries })
  }
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

const createWriteback = ({config, sourceRootForSlug, roomMetadata}) => {
  const writebackStates = new Map()
  const refreshWritebackBaseline = (document, projectRoot, state, stagedFields = null) => {
    const files = document.getMap('files')
    const knownFingerprints = (stagedFields || roomMetadata(document).fields).serverSourceFingerprints || {}
    const liveSources = readLiveManagedSources(projectRoot, config.maxRuntimeSyncBytes)
    const divergentWebPaths = []
    let historyChanged = false
    for (const [projectPath, liveSource] of Object.entries(liveSources)) {
      const text = files.get(projectPath)
      if (!(text instanceof Y.Text)) continue
      const sharedSource = text.toString()
      const liveDigest = sourceDigest(liveSource)
      const knownDigest = state.expectedDigests.get(projectPath)
      const priorSource = state.histories[projectPath]?.at(-1)
      const matchesRuntime = knownFingerprints[projectPath] === sourceFingerprint(liveSource)
      const unchanged = stagedFields ? matchesRuntime
        : knownDigest ? liveDigest === knownDigest
          : priorSource !== undefined ? liveSource === priorSource
            : matchesRuntime
      if (sharedSource !== liveSource && !unchanged) continue
      state.expectedDigests.set(projectPath, liveDigest)
      historyChanged = rememberSourceHistory(state.histories, projectPath, liveSource) || historyChanged
      if (sharedSource !== liveSource) divergentWebPaths.push(projectPath)
    }
    state.historyDirty ||= historyChanged
    if (state.historyDirty) {
      saveSourceHistories(config.sourceHistoryDir, state.docName, state.histories)
      state.historyDirty = false
    }
    return { divergentWebPaths, liveSources }
  }

  const flushSourceWriteback = (state, retry = true) => {
    state.timer = null
    const { document, files } = state
    if (!state.pendingPaths.size && !state.historyDirty) return
    const requestedPaths = [...state.pendingPaths]
    let outcome = 'synced'
    let recoveryPaths
    try {
      const result = writeBackManagedSources(document, state.projectRoot, state.expectedDigests, requestedPaths, config.maxRuntimeSyncBytes)
      const failures = result.failures || new Map()
      if (result.recoveries) recoveryPaths = [...result.recoveries.values()]
      for (const projectPath of requestedPaths) {
        state.pendingPaths.delete(projectPath)
        if (failures.has(projectPath)) state.retryPaths.add(projectPath)
        else {
          state.retryPaths.delete(projectPath)
          if (!result.conflictPaths.includes(projectPath)) state.conflictDrafts.delete(projectPath)
        }
      }
      for (const projectPath of result.writtenPaths) {
        state.historyDirty = rememberSourceHistory(state.histories, projectPath, files.get(projectPath)?.toString()) || state.historyDirty
      }
      if (state.historyDirty) {
        saveSourceHistories(config.sourceHistoryDir, state.docName, state.histories)
        state.historyDirty = false
      }
      for (const projectPath of result.conflictPaths) {
        const value = files.get(projectPath)?.toString()
        if (state.conflictDrafts.get(projectPath) === value) continue
        if (Y.encodeStateAsUpdate(document).byteLength + Buffer.byteLength(value) + 512 <= config.maxDocumentBytes) {
          const draft = nextServerDraftPath(files, projectPath, Date.now(), 0, 'writeback-conflict')
          document.transact(() => files.set(draft.path, new Y.Text(value)), 'server-writeback-status')
        }
        state.conflictDrafts.set(projectPath, value)
      }
      if (state.retryPaths.size) outcome = 'error'
      else if (state.conflictDrafts.size) outcome = 'conflict'
      const conflictKey = result.conflictPaths.join('\0')
      if (conflictKey && conflictKey !== state.lastConflictKey) {
        console.warn(`source writeback paused for external changes (${state.docName}): ${result.conflictPaths.join(', ')}`)
      }
      state.lastConflictKey = conflictKey
      for (const [projectPath, error] of failures) {
        console.error(`source writeback failed (${state.docName}, ${projectPath}): ${error.message}`)
      }
    } catch (error) {
      outcome = 'error'
      for (const projectPath of state.pendingPaths) state.retryPaths.add(projectPath)
      state.pendingPaths.clear()
      console.error(`source writeback failed (${state.docName}): ${error.message}`)
    }
    document.getMap('project').set('sourceWritebackStatus', {
      paths: [...new Set([...requestedPaths, ...state.retryPaths, ...state.conflictDrafts.keys()])], state: outcome, timestamp: Date.now(),
      ...(recoveryPaths && { recoveryPaths })
    })
    if (retry && !state.retryTimer && (state.retryPaths.size || state.historyDirty)) {
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null
        for (const projectPath of state.retryPaths) state.pendingPaths.add(projectPath)
        clearTimeout(state.timer)
        flushSourceWriteback(state)
      }, Math.max(config.sourceWritebackDebounceMs, 1000))
      state.retryTimer.unref()
    }
  }

  const disposeSourceWriteback = (docName, state, flush) => {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    clearTimeout(state.retryTimer)
    if (flush) {
      for (const projectPath of state.retryPaths) state.pendingPaths.add(projectPath)
      flushSourceWriteback(state, false)
    }
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
      conflictDrafts: new Map(),
      historyDirty: false,
      histories: loadSourceHistories(config.sourceHistoryDir, docName),
      lastConflictKey: '',
      pendingPaths: new Set(),
      retryPaths: new Set(),
      retryTimer: null,
      projectRoot,
      timer: null
    }
    const baseline = refreshWritebackBaseline(document, projectRoot, state)
    const files = document.getMap('files')
    state.files = files
    state.observer = (events, transaction) => {
      if (transaction.origin === 'server-runtime-sync' || transaction.origin === 'server-writeback-status') return
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

  const closeWriteback = () => {
    for (const [docName, state] of writebackStates) disposeSourceWriteback(docName, state, true)
  }
  return { ensureSourceWriteback, refreshWritebackBaseline, scheduleSourceWriteback, closeWriteback }
}

module.exports = { readLiveManagedSources, loadSourceHistories, saveSourceHistories, writeBackManagedSources, createWriteback }
