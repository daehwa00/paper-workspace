(() => {
  'use strict'

  const clone = value => JSON.parse(JSON.stringify(value))
  // Stable across reloads and JSON key order. The server independently verifies
  // its snapshot digest before replaying a restore for this key.
  function stableIdentifier(value) {
    const canonical = JSON.stringify(value, (_, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    })
    let forward = 0xcbf29ce484222325n, reverse = forward
    for (let i = 0; i < canonical.length; i++) {
      forward = BigInt.asUintN(64, (forward ^ BigInt(canonical.charCodeAt(i))) * 0x100000001b3n)
      reverse = BigInt.asUintN(64, (reverse ^ BigInt(canonical.charCodeAt(canonical.length - 1 - i))) * 0x100000001b3n)
    }
    return `${forward.toString(16)}:${reverse.toString(16)}`
  }

  function create({projectSlug, session}) {
    const base = `/api/rebuttal/projects/${encodeURIComponent(projectSlug)}`
    let cached = null
    let revision = 0
    let ready = false
    session.whenReady?.then(() => { ready = true }, () => {})
    function requireReady() {
      if (!ready || session.offline || !session.provider?.synced) throw new Error('Wait for collaboration synchronization before backing up or restoring rebuttal')
    }
    function sharedText(value) {
      return value?.doc === session.document && typeof value.toDelta === 'function' && typeof value.insert === 'function' && typeof value.delete === 'function'
    }
    async function request(path, options = {}) {
      const response = await fetch(`${base}${path}`, {
        credentials: 'same-origin', cache: 'no-store', ...options,
        headers: {Accept: 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers}
      })
      if (response.status === 404) return null
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `Rebuttal backup request failed (${response.status})`)
      return body
    }
    async function refresh() {
      const result = await request('/snapshot')
      if (result) {
        const candidate = result.snapshot || result.result?.snapshot || result
        if (candidate.schema_version !== 1 || !Array.isArray(candidate.rounds)) throw new Error('Invalid rebuttal backup response')
        cached = candidate
        revision = Number(result.revision ?? candidate.revision ?? revision)
      } else cached = null
      return cached
    }
    function snapshot() {
      if (!cached) return null
      requireReady()
      const result = clone(cached)
      result.texts = {...result.texts}
      const shared = session.document.getMap('rebuttalResponses')
      for (const round of result.rounds) {
        for (const document of round.documents || []) {
          const key = document.text_key || document.id
          const text = shared.get(key)
          if (!sharedText(text)) throw new Error('Shared rebuttal response is unavailable; wait for synchronization before backing up')
          result.texts[key] = text.toString()
        }
      }
      result.koreanResponses = {}
      const koreanMeta = session.document.getMap('rebuttalKoreanMeta')
      for (const round of result.rounds) for (const doc of round.documents || []) {
        const value = shared.get(`ko:${doc.id}`)
        if ((value !== undefined || doc.korean_seed) && !sharedText(value)) throw new Error('Shared Korean response is unavailable; wait for synchronization before backing up')
        if (sharedText(value)) result.koreanResponses[doc.id] = {text: value.toString(), meta: clone(koreanMeta.get(doc.id) || null)}
      }
      const rounds = new Map(result.rounds.map(round => [round.id, round]))
      const memoMap = session.document.getMap('rebuttalMemoEntries')
      result.memos = [...memoMap.values()].filter(memo => rounds.has(memo?.roundId)).map(memo => {
        const copy = clone(memo)
        if (copy.documentId && copy.quote) {
          const doc = rounds.get(copy.roundId)?.documents?.find(item => item.id === copy.documentId)
          const text = doc && shared.get(doc.text_key || doc.id)
          const range = text && session.resolveRange(copy, text)
          delete copy.anchorRelative; delete copy.headRelative
          if (range && text.toString().slice(...range) === copy.quote) copy.backupRange = range
        }
        return copy
      })
      const memoIds = new Set(result.memos.map(memo => memo.id))
      result.memoEvents = [...session.document.getMap('rebuttalMemoEvents').values()].filter(event => memoIds.has(event?.memoId)).map(clone)
      return result
    }
    async function restore(saved) {
      if (!saved) return null // Older manuscript backups must preserve rebuttal.
      if (saved.schema_version !== 1 || !Array.isArray(saved.rounds)) throw new Error('Invalid rebuttal backup')
      if (session.offline || typeof session.ensureNamespacedTexts !== 'function') throw new Error('Connect collaboration before restoring rebuttal')
      // Allow an already-resolved readiness promise to publish its state, but
      // never wait indefinitely or publish SQL rounds before initial sync.
      await Promise.resolve()
      requireReady()
      await refresh()
      const state = await request('/state')
      if (!state) throw new Error('Rebuttal must be enabled before restoring its backup')
      revision = state.revision
      requireReady()
      const result = await request('/restore', {method: 'POST', body: JSON.stringify({snapshot: saved, expected_revision: revision, idempotency_key: `snapshot:${stableIdentifier(saved)}`})})
      if (!result) throw new Error('Rebuttal restore is unavailable')
      const restoredTexts = result.result?.texts || {}
      const entries = Object.entries(restoredTexts).map(([key, initial]) => {
        if (typeof initial !== 'string') throw new Error('Invalid restored rebuttal text')
        return {key, initial}
      })
      const idMap = result.result?.id_map || {}
      const mappedId = id => Object.hasOwn(idMap, id) && typeof idMap[id] === 'string' ? idMap[id] : null
      const restoredDocumentIds = new Set(saved.rounds.flatMap(round => (round.documents || []).map(doc => mappedId(doc.id))).filter(Boolean))
      const korean = saved.koreanResponses && typeof saved.koreanResponses === 'object' && !Array.isArray(saved.koreanResponses) ? saved.koreanResponses : {}
      const koreanDrafts = new Map(Object.entries(korean).filter(([id, item]) => restoredDocumentIds.has(mappedId(id)) && item && typeof item.text === 'string').map(([id, item]) => [mappedId(id), item]))
      for (const round of result.rounds || []) for (const doc of round.documents || []) {
        if (restoredDocumentIds.has(doc.id) && typeof doc.korean_seed?.text === 'string') koreanDrafts.set(doc.id, doc.korean_seed)
      }
      const koreanEntries = [...koreanDrafts].map(([id, item]) => ({key: `ko:${id}`, initial: item.text}))
      // Other browsers receive the same immutable Korean seed in /state.
      // Allocate both languages together, preserving even existing empty texts.
      await session.ensureNamespacedTexts('rebuttalResponses', [...entries, ...koreanEntries])
      const metadataOwner = window.parent && window.parent !== window && window.parent.PaperWorkspaceSharedSession === session ? window.parent : window
      requireReady()
      const memos = Array.isArray(saved.memos) ? saved.memos : []
      const events = Array.isArray(saved.memoEvents) ? saved.memoEvents : []
      const memoIds = new Map(), restoredMemos = []
      const shared = session.document.getMap('rebuttalResponses')
      for (const memo of memos) {
        if (typeof memo?.id !== 'string') continue
        const roundId = mappedId(memo.roundId)
        const prefix = `${memo.roundId}:`
        if (!roundId || typeof memo.scope !== 'string' || !memo.scope.startsWith(prefix)) continue
        const oldScope = memo.scope.slice(prefix.length)
        const scope = oldScope === '' ? '' : mappedId(oldScope)
        if (scope === null) continue
        const id = `restore:${stableIdentifier([roundId, memo.id])}`
        memoIds.set(memo.id, id)
        const {backupRange, anchorRelative, headRelative, ...copy} = memo
        Object.assign(copy, {id, roundId, scope: `${roundId}:${scope}`})
        if (Object.hasOwn(copy, 'reviewerId')) copy.reviewerId = memo.reviewerId === '' ? '' : mappedId(memo.reviewerId)
        if (copy.documentId) copy.documentId = mappedId(copy.documentId)
        const text = copy.documentId && shared.get(copy.documentId)
        if (sharedText(text) && Array.isArray(backupRange) && backupRange.length === 2 && backupRange.every(Number.isSafeInteger) && backupRange[0] >= 0 && backupRange[1] <= text.length && text.toString().slice(...backupRange) === copy.quote) {
          Object.assign(copy, session.encodeTextRange(text, ...backupRange))
        }
        restoredMemos.push(copy)
      }
      const eventIds = new Map()
      for (const event of events) {
        const memoId = memoIds.get(event?.memoId)
        if (memoId && typeof event.id === 'string') eventIds.set(event.id, `restore:${stableIdentifier([memoId, event.id])}`)
      }
      session.document.transact(() => {
        const metadata = session.document.getMap('rebuttalKoreanMeta')
        for (const [id, item] of koreanDrafts) {
          const text = shared.get(`ko:${id}`)
          if (item.meta && !metadata.has(id) && sharedText(text) && text.toString() === item.text) {
            metadata.set(id, metadataOwner.JSON.parse(JSON.stringify(item.meta)))
          }
        }
        const memoMap = session.document.getMap('rebuttalMemoEntries')
        const eventMap = session.document.getMap('rebuttalMemoEvents')
        for (const memo of restoredMemos) {
          if (!memoMap.has(memo.id)) memoMap.set(memo.id, metadataOwner.JSON.parse(JSON.stringify(memo)))
        }
        for (const event of events) {
          const memoId = memoIds.get(event?.memoId), id = eventIds.get(event?.id)
          if (!memoId || !id || eventMap.has(id)) continue
          const copy = {...event, id, memoId}
          if (Array.isArray(event.parents)) copy.parents = event.parents.map(parent => eventIds.get(parent) || parent)
          eventMap.set(id, metadataOwner.JSON.parse(JSON.stringify(copy)))
        }
      })
      await refresh()
      return result
    }
    return {refresh, snapshot, restore}
  }
  window.PaperRebuttalBackup = Object.freeze({create})
})()
