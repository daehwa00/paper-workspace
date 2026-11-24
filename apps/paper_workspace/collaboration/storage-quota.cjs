'use strict'

const fs = require('node:fs')
const path = require('node:path')

const directoryBytes = async root => {
  if (!root) return 0
  let total = 0
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
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
          total += (await fs.promises.lstat(entryPath)).size
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

const monitorStorageQuota = ({root, limit, interval, onExceeded, onCheck}) => {
  let exceeded = false
  let running
  let closed = false
  const check = () => {
    if (running) return running
    onCheck()
    running = directoryBytes(root).then(bytes => {
      if (closed) return
      exceeded = bytes >= limit
      if (exceeded) onExceeded()
    }).catch(error => {
      console.error('collaboration storage check failed:', error.message)
    }).finally(() => { running = null })
    return running
  }
  const ready = check()
  const timer = setInterval(check, interval)
  timer.unref()
  return {
    ready,
    exceeded: () => exceeded,
    close() {
      closed = true
      clearInterval(timer)
    }
  }
}

module.exports = { directoryBytes, monitorStorageQuota }
