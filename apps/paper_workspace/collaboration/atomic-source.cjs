'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const sourceDigest = value => crypto.createHash('sha256').update(value).digest('hex')

const sameStat = (first, second) => first.dev === second.dev && first.ino === second.ino &&
  first.size === second.size && first.mtimeNs === second.mtimeNs

const sameSnapshot = (first, second) => first === null || second === null
  ? first === second
  : sameStat(first.stat, second.stat) && first.digest === second.digest

const readSnapshot = (filename, maxBytes) => {
  let descriptor
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error('source is not a regular file or exceeds its size limit')
    const bytes = fs.readFileSync(descriptor)
    if (bytes.length > maxBytes || !sameStat(stat, fs.fstatSync(descriptor, { bigint: true })) ||
        !sameStat(stat, fs.lstatSync(filename, { bigint: true }))) {
      throw new Error('source changed while being read')
    }
    return { bytes, digest: sourceDigest(bytes), stat }
  } catch (error) {
    if (error.code === 'ENOENT' && descriptor === undefined) return null
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

const flushDirectory = directory => {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

const atomicReplaceSource = (filename, value, expected, maxBytes, mode = 0o600) => {
  if (Buffer.byteLength(value) > maxBytes) throw new Error('source exceeds its size limit')
  const directory = path.dirname(filename)
  const suffix = `${process.pid}-${crypto.randomBytes(10).toString('hex')}`
  const temporary = path.join(directory, `.paper-writeback-${suffix}`)
  const guard = path.join(directory, `.paper-displaced-${suffix}`)
  let descriptor
  let guarded = false
  let keepGuard = false
  try {
    descriptor = fs.openSync(temporary, 'wx', mode)
    fs.writeFileSync(descriptor, value, 'utf8')
    fs.fsyncSync(descriptor)
    const installed = { stat: fs.fstatSync(descriptor, { bigint: true }), digest: sourceDigest(value) }
    if (expected) {
      try {
        fs.linkSync(filename, guard)
        guarded = true
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
      if (!sameSnapshot(readSnapshot(guard, maxBytes), expected) ||
          !sameSnapshot(readSnapshot(filename, maxBytes), expected)) return false
      fs.renameSync(temporary, filename)
      // A writer holding the old inode can still save during the rename.
      // Keep that inode as a recovery file if its contents changed.
      keepGuard = true
      if (!sameSnapshot(readSnapshot(guard, maxBytes), expected)) {
        flushDirectory(directory)
        const error = new Error('external edits were preserved during source writeback')
        error.recoveryPath = guard
        throw error
      }
      keepGuard = false
    } else {
      try { fs.linkSync(temporary, filename) } catch (error) {
        if (error.code === 'EEXIST') return false
        throw error
      }
    }
    flushDirectory(directory)
    return sameSnapshot(readSnapshot(filename, maxBytes), installed)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    for (const filename of guarded && !keepGuard ? [temporary, guard] : [temporary]) {
      try { fs.unlinkSync(filename) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
}

module.exports = { atomicReplaceSource, readSnapshot, sameSnapshot, sourceDigest }
