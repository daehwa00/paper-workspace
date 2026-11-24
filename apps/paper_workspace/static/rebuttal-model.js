// Pure mechanical checks. These never invoke a language model.
export function countText(text, limit = {}) {
  let value = String(text || '')
  if (limit.unit === 'pages') return null
  if (limit.include_headings === false) value = value.replace(/^\s{0,3}#{1,6}\s.*$/gm, '')
  if (limit.include_quotes === false) value = value.replace(/^\s*>.*$/gm, '')
  if (limit.include_math === false) value = value.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, '')
  if (limit.include_references === false) value = value.split(/^\s*#{0,6}\s*(?:References|Bibliography)\s*$/gim)[0]
  if (limit.basis === 'rendered') value = value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(^\s{0,3}#{1,6}\s+)|[`*_]/gm, '')
  if (limit.unit === 'words') return value.match(/\S+/gu)?.length || 0
  if (limit.count_spaces === false) value = value.replace(/[^\S\r\n]/g, '')
  if (limit.count_newlines === false) value = value.replace(/[\r\n]/g, '')
  return limit.character_mode === 'utf16' ? value.length : [...value].length
}
export function assemble(round, texts, target = {}) {
  let ids = target.document_ids || round.documents.map(doc => doc.id)
  if (target.common_mode === 'append') ids = [...ids.filter(id=>round.documents.find(doc=>doc.id===id)?.kind!=='common'),...round.documents.filter(doc=>doc.kind==='common').map(doc=>doc.id)]
  if (target.common_mode === 'prepend') ids = [...round.documents.filter(doc=>doc.kind==='common').map(doc=>doc.id),...ids.filter(id=>round.documents.find(doc=>doc.id===id)?.kind!=='common')]
  return ids.map(id=>round.documents.find(doc=>doc.id===id)).filter(doc=>doc && (doc.kind !== 'common' || target.common_mode !== 'exclude')).map(doc=>({...doc,text:texts[doc.id] ?? doc.seed_text ?? ''}))
}
export function checkLimits(round, texts, target = {}) {
  const rules = round.rules.find(rule => rule.id === round.active_rules_id)
  const documents = assemble(round, texts, target), checks=[]
  if(rules?.allow_common===false && documents.some(doc=>doc.kind==='common'))checks.push({scope:'target',unit:'common',count:1,max:0,passed:false})
  for(const limit of rules?.limits || []) {
    const selected = limit.scope === 'document' ? documents.filter(doc=>!limit.document_id || doc.id===limit.document_id) : limit.scope === 'total' ? round.documents.map(doc=>({...doc,text:texts[doc.id] ?? doc.seed_text ?? ''})) : documents
    const groups = limit.scope === 'document' ? selected.map(doc=>[doc]) : [selected]
    for(const group of groups) {const count=countText(group.map(doc=>doc.text).join('\n\n'),limit);checks.push({...limit,...(group.length===1?{document_id:group[0].id}:{}),count,passed:count===null?null:count<=limit.max})}
  }
  return checks
}
export function verifiedSpan(span, text, resolveRange) {
  let start = span.start, end = span.end
  if (span.anchorRelative) {
    const relative = resolveRange?.(span)
    if (!relative) return null
    ;[start, end] = relative
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length || text.slice(start, end) !== span.quote) return null
  return { ...span, start, end }
}
// Re-anchor unchanged sentence pairs against both the snapshot and live texts.
// Editing another sentence must not invalidate every connection in the document.
export function alignedResponseTranslation(span, original, translated, meta, resolveRange) {
  if(!original || !translated || typeof meta?.source!=='string' || !meta.source || typeof meta?.translation!=='string' || !meta.translation)return null
  const anchored=verifiedSpan(span,original,resolveRange);if(!anchored)return null
  const uniqueStart=(text,quote)=>{
    const start=text.indexOf(quote)
    return start>=0 && text.indexOf(quote,start+1)===-1 ? start : -1
  }
  const boundaryBefore=(text,start)=>{
    const prefix=text.slice(0,start)
    return !prefix.trim() || /[.!?。！？]["'”’)\]]*\s*$/.test(prefix) || /\n[ \t]*\n[ \t]*$/.test(prefix) || /(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+[^\n]*\n[ \t]*$/.test(prefix)
  }
  const boundaryAfter=(text,end)=>!text.slice(end).trim() || /^[ \t]*(?:[.!?。！？]|\r?\n[ \t]*\r?\n)/.test(text.slice(end))
  const unchangedEdges=(snapshot,current,previous,start,length)=>{
    if(boundaryBefore(snapshot,previous)){
      if(!boundaryBefore(current,start))return false
    }else if(snapshot.slice(0,previous).match(/\S+\s*$/)?.[0].trim()!==current.slice(0,start).match(/\S+\s*$/)?.[0].trim())return false
    // An intact sentence-ending delimiter is already a grounded right edge.
    if(/[.!?。！？]["'”’)\]]*$/.test(current.slice(start,start+length)))return true
    if(boundaryAfter(snapshot,previous+length))return boundaryAfter(current,start+length)
    return snapshot.slice(previous+length).match(/^\s*\S+/)?.[0].trim()===current.slice(start+length).match(/^\s*\S+/)?.[0].trim()
  }
  const segments=(Array.isArray(meta.segments)?meta.segments:[]).flatMap(pair=>{
    if(typeof pair?.source!=='string' || !pair.source || typeof pair.text!=='string' || !pair.text)return []
    const sourceStart=uniqueStart(meta.source,pair.source),targetStart=uniqueStart(meta.translation,pair.text)
    const a=uniqueStart(original,pair.source),b=uniqueStart(translated,pair.text)
    if(sourceStart<0 || targetStart<0 || a<0 || b<0)return []
    if(!unchangedEdges(meta.source,original,sourceStart,a,pair.source.length) || !unchangedEdges(meta.translation,translated,targetStart,b,pair.text.length))return []
    return [{start:a,end:a+pair.source.length,targetStart:b,targetEnd:b+pair.text.length,snapshotTargetStart:targetStart,snapshotTargetEnd:targetStart+pair.text.length}]
  })
  const containing=segments.filter(x=>x.start<=anchored.start && x.end>=anchored.end)
  if(containing.length===1){const x=containing[0];return {start:x.targetStart,end:x.targetEnd,text:translated.slice(x.targetStart,x.targetEnd)}}
  if(containing.length>1)return null
  const relevant=segments.filter(x=>x.end>anchored.start && x.start<anchored.end).sort((a,b)=>a.start-b.start)
  if(relevant.length>1){
    let cursor=anchored.start, target=-1, valid=true
    let previous=null
    for(const x of relevant){
      if(x.start>cursor && original.slice(cursor,x.start).trim())valid=false
      if(x.start<cursor && cursor!==anchored.start)valid=false
      if(x.targetStart<target)valid=false
      if(previous){
        const gap=translated.slice(previous.targetEnd,x.targetStart).replace(/\s+/g,'')
        const snapshotGap=meta.translation.slice(previous.snapshotTargetEnd,x.snapshotTargetStart).replace(/\s+/g,'')
        if(x.snapshotTargetStart<previous.snapshotTargetEnd || gap!==snapshotGap)valid=false
      }
      cursor=Math.max(cursor,x.end);target=x.targetEnd;previous=x
    }
    if(valid && cursor>=anchored.end){const start=relevant[0].targetStart,end=relevant.at(-1).targetEnd;return {start,end,text:translated.slice(start,end)}}
  }
  // A table row can be matched without translation guesses when at least two
  // unchanged bracketed identifiers uniquely identify it in both tables.
  if(/^[ \t]*\|[^\n]+\|[ \t]*$/.test(span.quote)){
    const tokens=[...new Set(span.quote.match(/\[[A-Za-z0-9][A-Za-z0-9_-]*\]/g) || [])]
    if(tokens.length>=2){
      const rows=text=>[...text.matchAll(/^[ \t]*\|[^\n]+\|[ \t]*$/gm)].filter(m=>tokens.every(token=>m[0].includes(token)))
      const sourceRows=rows(original),targetRows=rows(translated)
      const snapshotSourceRows=rows(meta.source),snapshotTargetRows=rows(meta.translation)
      if(sourceRows.length===1 && targetRows.length===1 && snapshotSourceRows.length===1 && snapshotTargetRows.length===1 && sourceRows[0][0].trim()===span.quote.trim() && sourceRows[0][0].trim()===snapshotSourceRows[0][0].trim() && targetRows[0][0].trim()===snapshotTargetRows[0][0].trim()){
        const match=targetRows[0];return {start:match.index,end:match.index+match[0].length,text:match[0]}
      }
    }
  }
  return null
}
export function replaceSharedText(shared, value, origin) {
  const previous = shared.toString()
  if (previous === value) return
  let start = 0, oldEnd = previous.length, newEnd = value.length
  while (start < Math.min(oldEnd, newEnd) && previous[start] === value[start]) start++
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd-- }
  const update = () => { if (oldEnd > start) shared.delete(start, oldEnd - start); if (newEnd > start) shared.insert(start, value.slice(start, newEnd)) }
  shared.doc.transact(update, origin)
}

// Apply only edits made since the form opened. Preserve unrelated remote fields
// and identify overlapping edits instead of silently using a refreshed revision.
export function mergeRoundEdit(base, edited, latest) {
  const missing = Symbol('missing')
  const equal = (a, b) => a === b || (a !== missing && b !== missing && JSON.stringify(a) === JSON.stringify(b))
  const object = value => value !== missing && value !== null && typeof value === 'object' && !Array.isArray(value)
  const keyed = value => Array.isArray(value) && value.every(item => object(item) && typeof item.id === 'string') && new Set(value.map(item => item.id)).size === value.length
  const conflicts = []
  function merge(before, local, remote, path) {
    if (equal(before, local)) return remote
    if (equal(before, remote) || equal(local, remote)) return local
    if (object(before) && object(local) && object(remote)) {
      const result = {}
      for (const key of new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(remote)])) {
        const value = merge(Object.hasOwn(before, key) ? before[key] : missing, Object.hasOwn(local, key) ? local[key] : missing, Object.hasOwn(remote, key) ? remote[key] : missing, [...path, key])
        if (value !== missing) result[key] = value
      }
      return result
    }
    if (keyed(before) && keyed(local) && keyed(remote)) {
      const maps = [before, local, remote].map(items => new Map(items.map(item => [item.id, item])))
      const result = []
      for (const id of new Set([...remote.map(item => item.id), ...local.map(item => item.id), ...before.map(item => item.id)])) {
        const value = merge(...maps.map(map => map.has(id) ? map.get(id) : missing), [...path, id])
        if (value !== missing) result.push(value)
      }
      return result
    }
    conflicts.push(path)
    return remote
  }
  return { round: merge(base, edited, latest, []), conflicts }
}
export const uid = () => crypto.randomUUID()

export function isBlockingLimit(check) {
  return check.passed === false && check.basis !== 'rendered'
}
