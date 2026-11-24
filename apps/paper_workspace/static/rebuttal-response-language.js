// Keep translated responses separate from the canonical submission text.
// Alignment is only valid for the exact source and translation it was built from.
export function responseLanguageState({source = '', translation = '', alignedSource = null, alignedTranslation = null} = {}) {
  return {
    hasTranslation: Boolean(translation.trim()),
    sourceChanged: alignedSource !== null && source !== alignedSource,
    alignmentValid: alignedSource !== null && alignedTranslation !== null && source === alignedSource && translation === alignedTranslation
  }
}

export function translatedResponseRange({source, translation, alignedSource, alignedTranslation, segments}, quote) {
  const state = responseLanguageState({source, translation, alignedSource, alignedTranslation})
  if (!state.alignmentValid || !quote || !Array.isArray(segments)) return null
  if (source.indexOf(quote) < 0 || source.indexOf(quote) !== source.lastIndexOf(quote)) return null
  const candidates = segments.filter(item => typeof item?.source === 'string' && item.source.includes(quote) && typeof item.text === 'string' && item.text.length > 0 && source.indexOf(item.source) === source.lastIndexOf(item.source) && source.includes(item.source) && translation.indexOf(item.text) === translation.lastIndexOf(item.text) && translation.includes(item.text))
  if (candidates.length !== 1) return null
  const start = translation.indexOf(candidates[0].text)
  return {start, end: start + candidates[0].text.length, quote: candidates[0].text}
}

// With no provenance, any existing text is a manual draft. An intentionally
// cleared translation is also a manual edit when the previous text was nonempty.
export function isManualKoreanDraft(current, metadata) {
  return current !== (typeof metadata?.translation === 'string' ? metadata.translation : '')
}

export function commitKoreanTranslation({text, metadata, id, expected, provenance, origin}) {
  let applied = false
  text.doc.transact(() => {
    if (text.toString() !== expected) return
    if (expected !== provenance.translation) {
      if (text.length) text.delete(0, text.length)
      if (provenance.translation) text.insert(0, provenance.translation)
    }
    metadata.set(id, provenance)
    applied = true
  }, origin)
  return applied
}
