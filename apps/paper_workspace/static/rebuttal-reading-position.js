// Reading positions are approximate within a translated block, never evidence
// anchors. Repeated blocks are located in their recorded translation order.
export function translatedReadingPosition(position, english, korean, meta, from = 'en') {
  if (!Number.isFinite(position) || typeof english !== 'string' || typeof korean !== 'string' ||
      typeof meta?.source !== 'string' || meta.source.replace(/\r\n?/g, '\n') !== english || meta.translation !== korean) return null
  let sourceCursor = 0, targetCursor = 0
  for (const pair of Array.isArray(meta.segments) ? meta.segments : []) {
    if (typeof pair?.source !== 'string' || typeof pair.text !== 'string' || !pair.source || !pair.text) continue
    const source = pair.source.replace(/\r\n?/g, '\n')
    const a = english.indexOf(source, sourceCursor), b = korean.indexOf(pair.text, targetCursor)
    if (a < 0 || b < 0) continue
    sourceCursor = a + source.length; targetCursor = b + pair.text.length
    const start = from === 'en' ? a : b, length = from === 'en' ? source.length : pair.text.length
    const target = from === 'en' ? b : a, targetLength = from === 'en' ? pair.text.length : source.length
    if (position >= start && position < start + length) {
      return target + Math.min(targetLength, Math.round((position - start) / length * targetLength))
    }
  }
  const fromLength = from === 'en' ? english.length : korean.length
  const toLength = from === 'en' ? korean.length : english.length
  if (position === fromLength && sourceCursor && targetCursor &&
      !english.slice(sourceCursor).trim() && !korean.slice(targetCursor).trim()) return toLength
  return null
}
