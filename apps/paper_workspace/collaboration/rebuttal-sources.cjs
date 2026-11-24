'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Y = require('yjs')
const { atomicReplaceSource, readSnapshot, sameSnapshot } = require('./atomic-source.cjs')
const { mergeTextHistory } = require('./source-merge.cjs')

const validKey = key => typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,239}$/.test(key)
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

const boundedHistory = (values, maxBytes) => {
  const retained = []
  let bytes = 0
  for (const value of values.slice().reverse()) {
    if (typeof value !== 'string' || retained.includes(value)) continue
    const size = Buffer.byteLength(JSON.stringify(value))
    if (retained.length >= 4 || bytes + size > maxBytes) continue
    retained.unshift(value)
    bytes += size
  }
  return retained
}

// Never follow a symlink, including one in a parent directory. These files are
// writable by server-side tools, so every operation revalidates the path.
const safeDirectory = (root, relative, create = true) => {
  if (fs.realpathSync(root) !== path.resolve(root) || !fs.lstatSync(root).isDirectory()) throw new Error('unsafe project directory')
  let current = root
  for (const segment of relative.split('/').filter(Boolean)) {
    current = path.join(current, segment)
    if (create) {
      try { fs.mkdirSync(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe rebuttal directory')
  }
  return current
}

const readFile = (root, relative, maxBytes) => {
  safeDirectory(root, path.posix.dirname(relative), false)
  const snapshot = readSnapshot(path.join(root, relative), maxBytes)
  return snapshot && { ...snapshot, value: decode(snapshot.bytes) }
}

const atomicWrite = (root, relative, value, expected, maxBytes) => {
  safeDirectory(root, path.posix.dirname(relative))
  if (!atomicReplaceSource(path.join(root, relative), value, expected, maxBytes)) {
    throw new Error('rebuttal file changed during synchronization; retrying safely')
  }
}

const containsSnapshot = (document, encoded) => {
  try {
    const expected = Y.decodeSnapshot(Buffer.from(encoded, 'base64'))
    const current = Y.snapshot(document)
    if (![...expected.sv].every(([client, clock]) => (current.sv.get(client) || 0) >= clock)) return false
    // Deletions do not advance state-vector clocks. Check their ranges too,
    // or a baseline written just before a crash could trust undeleted text.
    return [...expected.ds.clients].every(([client, ranges]) => ranges.every(range =>
      (current.ds.clients.get(client) || []).some(actual => actual.clock <= range.clock && actual.clock + actual.len >= range.clock + range.len)
    ))
  } catch { return false }
}

const replaceText = (text, value) => {
  const before = text.toString()
  let prefix = 0
  while (prefix < before.length && prefix < value.length && before[prefix] === value[prefix]) prefix += 1
  let suffix = 0
  while (suffix < before.length - prefix && suffix < value.length - prefix && before[before.length - suffix - 1] === value[value.length - suffix - 1]) suffix += 1
  if (before.length - prefix - suffix) text.delete(prefix, before.length - prefix - suffix)
  if (value.length - prefix - suffix) text.insert(prefix, value.slice(prefix, value.length - suffix))
}

const createRebuttalSourceSync = ({ document, projectRoot, pollMs = 1000, maxBytes = 8 * 1024 * 1024, maxDocumentBytes = 32 * 1024 * 1024 }) => {
  const root = path.resolve(projectRoot)
  // JSON escaping can expand a UTF-8 text byte up to six bytes. History has
  // its own serialized maxBytes budget; leave bounded room for both.
  const maxBaselineBytes = maxBytes * 7 + 65536
  const responses = document.getMap('rebuttalResponses')
  const statuses = document.getMap('rebuttalSourceStatus')
  let closed = false
  let syncing = false
  const racedWrites = new Map()
  const publish = (key, status) => {
    if (JSON.stringify(statuses.get(key)) !== JSON.stringify(status)) statuses.set(key, status)
  }
  const checkDocumentGrowth = additions => {
    if (!additions.length) return
    // Replaced Yjs structs can remain in encoded history. Do not subtract the
    // old text; budget the complete replacement plus conservative per-entry
    // metadata before mutating any shared text or its Markdown counterpart.
    const growth = additions.reduce((total, entry) => total + Buffer.byteLength(entry.value) + Buffer.byteLength(entry.key) + 1024, 0)
    if (Y.encodeStateAsUpdate(document).byteLength + growth > maxDocumentBytes) throw new Error('rebuttal change exceeds the collaboration document size limit')
  }
  const syncKey = (key, text) => {
    const sourcePath = `rebuttal/responses/${key}.md`
    const baselinePath = `rebuttal/.sync/${key}.json`
    const status = { state: 'synced', path: sourcePath }
    try {
      safeDirectory(root, 'rebuttal/responses')
      safeDirectory(root, 'rebuttal/.sync')
      const baselineFile = readFile(root, baselinePath, maxBaselineBytes)
      let baseline
      try { baseline = baselineFile && JSON.parse(baselineFile.value) } catch { baseline = null }
      const web = text.toString()
      if (Buffer.byteLength(web) > maxBytes) throw new Error('rebuttal response exceeds its size limit')
      let disk = readFile(root, sourcePath, maxBytes)
      if (!disk && baselineFile) {
        publish(key, { ...status, state: 'missing', message: 'Server response file is missing; web text has been preserved.' })
        return
      }
      if (!disk) {
        atomicWrite(root, sourcePath, web, null, maxBytes)
        disk = readFile(root, sourcePath, maxBytes)
      }
      const validBase = baseline?.version === 1 && typeof baseline.text === 'string' && typeof baseline.snapshot === 'string' && containsSnapshot(document, baseline.snapshot)
      let next = web
      let conflict = null
      let recoveryPath = null
      if (web !== disk.value) {
        const history = boundedHistory(Array.isArray(baseline?.history) ? baseline.history : [], maxBytes)
        const candidates = validBase ? [...history, baseline.text] : []
        const merged = validBase ? mergeTextHistory(candidates, web, disk.value) : { conflict: true, reason: 'missing-base' }
        if (merged.conflict) {
          const prefix = `rebuttal/conflicts/${key.slice(0, 80)}-${digest(key).slice(0, 12)}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
          const conflictPaths = [`${prefix}-web.md`, `${prefix}-server.md`]
          atomicWrite(root, conflictPaths[0], web, null, maxBytes)
          atomicWrite(root, conflictPaths[1], disk.value, null, maxBytes)
          conflict = { ...status, state: 'conflict', reason: merged.reason, conflictPaths }
          next = disk.value
        } else next = merged.value
      }
      // Do not alter the shared text unless its server counterpart is still
      // the version that was merged/preserved above.
      const checked = readFile(root, sourcePath, maxBytes)
      if (!disk || !sameSnapshot(checked, disk)) throw new Error('rebuttal file changed during synchronization; retrying safely')
      if (next !== web) checkDocumentGrowth([{ key, value: next }])
      if (next !== web && !conflict) {
        // Even an editor older than the bounded merge history must never
        // erase the current web version. Archive it by content hash before
        // importing server text; ordinary server edits remain synchronized.
        recoveryPath = `rebuttal/.sync/history/${digest(key)}-${digest(web)}.md`
        safeDirectory(root, 'rebuttal/.sync/history')
        const recovered = readFile(root, recoveryPath, maxBytes)
        if (!recovered) atomicWrite(root, recoveryPath, web, null, maxBytes)
        else if (recovered.value !== web) throw new Error('rebuttal recovery history integrity mismatch')
      }
      if (next !== disk.value) atomicWrite(root, sourcePath, next, disk, maxBytes)
      else if (!sameSnapshot(readFile(root, sourcePath, maxBytes), disk)) throw new Error('rebuttal file changed during synchronization; retrying safely')
      document.transact(() => replaceText(text, next), 'rebuttal-source-sync')
      const previousConflict = baseline?.status?.state === 'conflict' ? baseline.status : null
      const nextStatus = conflict || racedWrites.get(key) || previousConflict || (recoveryPath ? { ...status, recoveryPath } : baseline?.status?.state === 'synced' ? baseline.status : status)
      // Persist the exact shared state covered by this baseline. If LevelDB
      // later restores an older state, its snapshot will fail validation and
      // both copies will be preserved instead of trusting an advanced base.
      const previousVersions = [...(Array.isArray(baseline?.history) ? baseline.history : [])]
      if (typeof baseline?.text === 'string' && baseline.text !== next) previousVersions.push(baseline.text)
      const history = boundedHistory(previousVersions, maxBytes)
      const nextBaseline = JSON.stringify({ version: 1, text: next, history, snapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(document))).toString('base64'), status: nextStatus })
      if (baselineFile?.value !== nextBaseline) atomicWrite(root, baselinePath, nextBaseline, baselineFile, maxBaselineBytes)
      racedWrites.delete(key)
      publish(key, nextStatus)
    } catch (error) {
      if (error.recoveryPath) {
        const conflict = { ...status, state: 'conflict', reason: 'concurrent-server-save', conflictPaths: [path.relative(root, error.recoveryPath)] }
        racedWrites.set(key, conflict)
        publish(key, conflict)
        return
      }
      publish(key, { ...status, state: 'error', message: error.message })
    }
  }
  const sync = () => {
    if (closed || syncing) return
    syncing = true
    try {
      for (const [key, value] of responses) {
        if (validKey(key) && value instanceof Y.Text) syncKey(key, value)
      }
    } finally { syncing = false }
  }
  const ensureTexts = entries => {
    if (closed) throw new Error('rebuttal source synchronization is closed')
    if (!Array.isArray(entries)) throw new Error('invalid rebuttal response entries')
    safeDirectory(root, 'rebuttal/responses')
    const prepared = entries.map(entry => {
      if (!validKey(entry?.key) || typeof entry.initial !== 'string') throw new Error('invalid rebuttal response entry')
      const existing = responses.get(entry.key)
      if (existing !== undefined && !(existing instanceof Y.Text)) throw new Error('invalid shared rebuttal response')
      if (existing) return { key: entry.key }
      const disk = readFile(root, `rebuttal/responses/${entry.key}.md`, maxBytes)
      const value = disk ? disk.value : entry.initial
      if (Buffer.byteLength(value) > maxBytes) throw new Error('rebuttal response exceeds its size limit')
      return { key: entry.key, value }
    })
    const additions = new Map()
    for (const entry of prepared) {
      if (entry.value !== undefined && !additions.has(entry.key)) additions.set(entry.key, entry)
    }
    checkDocumentGrowth([...additions.values()])
    document.transact(() => {
      for (const entry of prepared) {
        if (!responses.has(entry.key)) responses.set(entry.key, new Y.Text(entry.value))
      }
    }, 'rebuttal-source-init')
    sync()
  }
  const close = () => {
    if (closed) return
    sync()
    closed = true
    responses.unobserveDeep(sync)
    document.off('destroy', close)
    clearInterval(timer)
  }
  responses.observeDeep(sync)
  document.on('destroy', close)
  const timer = pollMs > 0 ? setInterval(sync, pollMs) : null
  timer?.unref()
  sync()
  return { sync, close, ensureTexts }
}

module.exports = { createRebuttalSourceSync }
