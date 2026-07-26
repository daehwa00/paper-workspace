'use strict'

const MAX_LCS_CELLS = 4_000_000

const linesOf = value => String(value ?? '').match(/[^\n]*\n|[^\n]+$/g) || []

const sequenceEdits = (base, variant) => {
  const left = linesOf(base)
  const right = linesOf(variant)
  if ((left.length + 1) * (right.length + 1) > MAX_LCS_CELLS) return null
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? table[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1])
    }
  }
  const edits = []
  let leftIndex = 0
  let rightIndex = 0
  let pending = null
  const flush = () => {
    if (!pending) return
    edits.push(pending)
    pending = null
  }
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) {
      flush()
      leftIndex += 1
      rightIndex += 1
      continue
    }
    pending ||= { end: leftIndex, lines: [], start: leftIndex }
    if (
      rightIndex < right.length &&
      (leftIndex === left.length || table[leftIndex][rightIndex + 1] >= table[leftIndex + 1][rightIndex])
    ) {
      pending.lines.push(right[rightIndex])
      rightIndex += 1
    } else {
      leftIndex += 1
      pending.end = leftIndex
    }
  }
  flush()
  const cost = edits.reduce((total, edit) => total + (edit.end - edit.start) + edit.lines.length, 0)
  return { baseLines: left, cost, edits }
}

const equalEdit = (left, right) => left.start === right.start &&
  left.end === right.end &&
  left.lines.length === right.lines.length &&
  left.lines.every((line, index) => line === right.lines[index])

const editsConflict = (left, right) => {
  if (equalEdit(left, right)) return false
  const leftInsert = left.start === left.end
  const rightInsert = right.start === right.end
  if (leftInsert && rightInsert) return left.start === right.start
  if (leftInsert) return left.start > right.start && left.start < right.end
  if (rightInsert) return right.start > left.start && right.start < left.end
  return left.start < right.end && right.start < left.end
}

const mergeTextVersions = (base, web, server) => {
  if (web === server) return { conflict: false, value: web }
  if (web === base) return { conflict: false, value: server }
  if (server === base) return { conflict: false, value: web }
  const webDiff = sequenceEdits(base, web)
  const serverDiff = sequenceEdits(base, server)
  if (!webDiff || !serverDiff) return { conflict: true, reason: 'document-too-large' }
  for (const webEdit of webDiff.edits) {
    for (const serverEdit of serverDiff.edits) {
      if (editsConflict(webEdit, serverEdit)) return { conflict: true, reason: 'overlapping-edits' }
    }
  }
  const combined = [...webDiff.edits]
  for (const serverEdit of serverDiff.edits) {
    if (!combined.some(webEdit => equalEdit(webEdit, serverEdit))) combined.push(serverEdit)
  }
  combined.sort((left, right) => right.start - left.start || right.end - left.end)
  const merged = [...webDiff.baseLines]
  for (const edit of combined) merged.splice(edit.start, edit.end - edit.start, ...edit.lines)
  return { conflict: false, value: merged.join('') }
}

const mergeTextHistory = (history, web, server) => {
  const candidates = [...new Set((Array.isArray(history) ? history : []).filter(value => typeof value === 'string'))]
  if (!candidates.length) return { conflict: true, reason: 'missing-base' }
  // On equal distance prefer the oldest retained common version. A local
  // editor may have started before a newer browser writeback and can later
  // save that stale base; choosing the newest tie would silently legitimize
  // the stale overwrite instead of reporting an overlap.
  let selected = candidates[0]
  let selectedCost = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const difference = sequenceEdits(candidate, server)
    if (difference && difference.cost < selectedCost) {
      selected = candidate
      selectedCost = difference.cost
    }
  }
  return { ...mergeTextVersions(selected, web, server), base: selected }
}

module.exports = {
  mergeTextHistory,
  mergeTextVersions,
  sequenceEdits
}
