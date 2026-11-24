import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'

const toBase64 = bytes => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return btoa(binary)
}
const fromBase64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0))

const textChange = (before, after) => {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let end = before.length, afterEnd = after.length
  while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) {
    end -= 1
    afterEnd -= 1
  }
  return { start, end, insert: after.slice(start, afterEnd) }
}

const applyTextChange = (text, { start, end, insert }) => {
  if (end > start) text.delete(start, end - start)
  if (insert) text.insert(start, insert)
}

export function createSession({ url, room, actor, onStatus, onPeers }) {
  const document = new Y.Doc()
  const persistence = new IndexeddbPersistence(`paper-workspace-crdt:${room}`, document)
  // Register the initial sync waiter before opening the socket. A fast local or
  // resumed connection can otherwise emit `sync` before `whenReady` subscribes,
  // leaving workspace bootstrap pending even though the provider is synced.
  const provider = new WebsocketProvider(url, room, document, { connect: false })
  const files = document.getMap('files')
  const awareness = provider.awareness
  let bootstrapReady = false
  const provisionalFiles = new Map()
  const adoptedTexts = new WeakMap()
  const bridgeOrigin = Symbol('file-initialization-bridge')
  const initAbort = new AbortController()
  const bootstrapSettleMs = 400
  actor = actor ? { ...actor } : null
  awareness.setLocalStateField('user', actor)

  let peersScheduled = false, destroyed = false
  const disconnectedPeerClocks = new Map()
  const schedulePeers = () => {
    if (peersScheduled || destroyed) return
    peersScheduled = true
    queueMicrotask(() => {
      peersScheduled = false
      if (!destroyed) publishPeers()
    })
  }

  let resolveInitialServerSync
  const initialServerSync = new Promise(resolve => { resolveInitialServerSync = resolve })
  provider.on('status', event => {
    if (event.status === 'connected') {
      // Transport loss removes remote states locally, retaining their clocks.
      // Accept the server's same-clock snapshot without forgetting confirmed departures.
      for (const [clientId, clock] of disconnectedPeerClocks) {
        if (!awareness.getStates().has(clientId) && awareness.meta.get(clientId)?.clock === clock) awareness.meta.delete(clientId)
      }
      disconnectedPeerClocks.clear()
      const local = awareness.getLocalState()
      if (local !== null) awareness.setLocalState(local)
    }
    onStatus?.(event.status)
    schedulePeers()
  })
  provider.on('sync', synced => {
    onStatus?.(synced ? 'synced' : 'connecting')
    if (synced) {
      resolveInitialServerSync()
      queueMicrotask(() => {
        if (bootstrapReady && !destroyed) for (const [path, entry] of provisionalFiles) {
          if (entry.requested) requestFile(path, entry)
        }
      })
    }
    schedulePeers()
  })
  const publishPeers = () => {
    const peers = []
    if (provider.wsconnected) awareness.getStates().forEach((state, clientId) => {
      if (clientId !== document.clientID && state.user) peers.push({ ...state.user, ...state.cursor, clientId, workspace: state.workspace, rebuttal: state.rebuttal })
    })
    onPeers?.(peers)
  }
  const awarenessChanged = ({ removed }, origin) => {
    if (origin === provider && !provider.wsconnected) {
      for (const clientId of removed) {
        if (clientId !== document.clientID && awareness.meta.has(clientId)) disconnectedPeerClocks.set(clientId, awareness.meta.get(clientId).clock)
      }
    }
    schedulePeers()
  }
  awareness.on('change', awarenessChanged)
  provider.connect()

  const isBootstrapLeader = () => Math.min(...awareness.getStates().keys()) === document.clientID
  const provisionalEntry = (path, initial) => {
    let entry = provisionalFiles.get(path)
    if (!entry) {
      const provisionalDocument = new Y.Doc()
      const text = provisionalDocument.getText('text')
      if (initial) text.insert(0, initial)
      entry = { document: provisionalDocument, text, initial, beforeBootstrap: !bootstrapReady }
      provisionalFiles.set(path, entry)
    }
    return entry
  }
  const provisionalTextFor = (path, initial) => provisionalEntry(path, initial).text

  const initializeFile = async (path, value) => {
    const response = await fetch(`/collab-runtime/${encodeURIComponent(room)}?file-init=1`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: initAbort.signal,
      body: JSON.stringify({ entries: [{ key: path, initial: value }], state_vector: toBase64(Y.encodeStateVector(document)) })
    })
    if (!response.ok) {
      const error = new Error('Could not initialize shared file')
      error.retryable = response.status === 409 || response.status >= 500
      throw error
    }
    const result = await response.json()
    if (!destroyed) Y.applyUpdate(document, fromBase64(result.update), 'file-initialization')
  }

  const adoptFile = (path, entry, shared) => {
    const local = entry.text.toString()
    const remote = shared.toString()
    if (local !== entry.initial && local !== remote) {
      const edit = textChange(entry.initial, local)
      const peer = textChange(entry.initial, remote)
      if (remote === entry.initial || edit.end <= peer.start) {
        document.transact(() => applyTextChange(shared, edit), bridgeOrigin)
      } else if (peer.end <= edit.start) {
        const offset = peer.insert.length - (peer.end - peer.start)
        document.transact(() => applyTextChange(shared, { ...edit, start: edit.start + offset, end: edit.end + offset }), bridgeOrigin)
      } else {
        // Preserve intersecting edits as a separate shared draft before adopting.
        if (entry.draftValue !== local) {
          const identifier = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-')
          entry.draftPath = `paper/drafts/file-init-${identifier}-${path.split('/').at(-1).slice(-80)}`
          entry.draftValue = local
        }
        return initializeFile(entry.draftPath, local).then(() => {
          if (destroyed) return
          entry.initial = local
          return adoptFile(path, entry, shared)
        })
      }
    }
    entry.shared = shared
    adoptedTexts.set(entry.text, shared)
    entry.mirror = event => {
      if (event.transaction.origin === bridgeOrigin) return
      entry.document.transact(() => entry.text.applyDelta(event.delta), bridgeOrigin)
    }
    entry.forward = event => {
      if (event.transaction.origin === bridgeOrigin) return
      document.transact(() => shared.applyDelta(event.delta), bridgeOrigin)
    }
    entry.document.transact(() => applyTextChange(entry.text, textChange(local, shared.toString())), bridgeOrigin)
    shared.observe(entry.mirror)
    entry.text.observe(entry.forward)
  }

  const requestFile = (path, entry) => {
    if (entry.pending || entry.shared || destroyed) return
    clearTimeout(entry.retry)
    const shared = files.get(path)
    if (!(shared instanceof Y.Text) && !provider.synced) return
    entry.pending = Promise.resolve().then(async () => {
      if (!(files.get(path) instanceof Y.Text)) await initializeFile(path, entry.initial)
      if (destroyed || provisionalFiles.get(path) !== entry) return
      const canonical = files.get(path)
      if (!(canonical instanceof Y.Text)) throw new Error('Shared file is unavailable')
      await adoptFile(path, entry, canonical)
    }).catch(error => {
      if (destroyed) return
      if (error.retryable !== false) {
        entry.retry = setTimeout(() => requestFile(path, entry), 1500)
      }
    }).finally(() => { entry.pending = null })
  }

  const disposeFile = entry => {
    clearTimeout(entry.retry)
    if (entry.shared) entry.shared.unobserve(entry.mirror)
    entry.document.destroy()
  }

  const textFor = (path, initial = '') => {
    const shared = files.get(path)
    let entry = provisionalFiles.get(path)
    // The workspace keeps pre-sync edits as drafts and explicitly rebinds.
    // Only bridge edits made while an initialized session is allocating a file.
    if (entry?.beforeBootstrap && bootstrapReady) {
      disposeFile(entry)
      provisionalFiles.delete(path)
      entry = null
    }
    if (shared instanceof Y.Text && !entry) {
      if (!shared.length && initial && bootstrapReady && isBootstrapLeader() &&
          !document.getMap('project').has('serverRuntimeRevision')) shared.insert(0, initial)
      return shared
    }
    if (entry?.shared && entry.shared !== shared) {
      disposeFile(entry)
      provisionalFiles.delete(path)
      entry = null
    }
    entry ||= provisionalEntry(path, shared instanceof Y.Text ? shared.toString() : initial)
    if (!entry.initial && initial && !entry.text.length && !(shared instanceof Y.Text)) {
      if (!entry.pending) entry.initial = initial
      entry.text.insert(0, initial)
    }
    if (bootstrapReady) {
      entry.requested = true
      requestFile(path, entry)
    }
    return entry.shared || entry.text
  }

  const setCursor = (path, start, end = start) => {
    const text = textFor(path)
    const anchor = Y.createRelativePositionFromTypeIndex(text, Math.min(start, text.length))
    const head = Y.createRelativePositionFromTypeIndex(text, Math.min(end, text.length))
    awareness.setLocalStateField('cursor', {
      active_file: path,
      anchor: toBase64(Y.encodeRelativePosition(anchor)),
      head: toBase64(Y.encodeRelativePosition(head))
    })
  }

  const encodeRange = (path, start, end = start) => {
    const text = textFor(path)
    return {
      anchorRelative: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.min(start, text.length)))),
      headRelative: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.min(end, text.length))))
    }
  }

  const resolveRange = (range, expectedText) => {
    try {
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(range.anchorRelative)), document)
      const head = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(range.headRelative)), document)
      return anchor && head && anchor.type === head.type && (!expectedText || anchor.type === (adoptedTexts.get(expectedText) || expectedText)) ? [anchor.index, head.index] : null
    } catch {
      return null
    }
  }

  const resolveCursor = (peer, expectedText) => {
    try {
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(peer.anchor)), document)
      const head = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(peer.head)), document)
      const text = adoptedTexts.get(expectedText) || expectedText || (peer.active_file ? files.get(peer.active_file) : null)
      if (!anchor || !head || anchor.type !== head.type || (text && anchor.type !== text)) return null
      if (!expectedText && peer.active_file && !text) return null
      return [anchor.index, head.index]
    } catch {
      return null
    }
  }

  const updateActor = nextActor => {
    actor = nextActor ? { ...nextActor } : null
    if (JSON.stringify(awareness.getLocalState()?.user) !== JSON.stringify(actor)) awareness.setLocalStateField('user', actor)
  }

  // Allocate shared response types on the server. Concurrent map.set(Y.Text)
  // calls create competing CRDT objects; merging them discards one whole draft.
  const responseInitializations = new Map()
  const ensureNamespacedTexts = async (namespace, entries) => {
    if (namespace !== 'rebuttalResponses') throw new Error('Unsupported text namespace')
    if (!bootstrapReady || !provider.synced) throw new Error('Wait for collaboration synchronization before opening responses')
    const map = document.getMap(namespace)
    const missing = entries.filter(entry => !(map.get(entry.key) instanceof Y.Text))
    if (!missing.length) return
    const pending = missing.filter(entry => responseInitializations.has(entry.key)).map(entry => responseInitializations.get(entry.key))
    const fresh = missing.filter(entry => !responseInitializations.has(entry.key))
    if (fresh.length) {
      const initialize = async () => {
        let batch = [], size = 0
        const send = async () => {
          if (!batch.length) return
          const response = await fetch(`/collab-runtime/${encodeURIComponent(room)}?response-init=1`, {
            method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({entries: batch, state_vector: toBase64(Y.encodeStateVector(document))})
          })
          const result = await response.json()
          if (!response.ok) throw new Error(result.error || 'Could not initialize shared responses')
          if (typeof result.update !== 'string') throw new Error('Invalid shared response initialization')
          Y.applyUpdate(document, fromBase64(result.update), 'response-initialization')
          for (const entry of batch) if (!(map.get(entry.key) instanceof Y.Text)) throw new Error('Shared response is unavailable')
          batch = []; size = 0
        }
        for (const entry of fresh) {
          const value = {key: entry.key, initial: String(entry.initial ?? '')}
          const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
          if (bytes > 4_000_000) throw new Error('Response seed exceeds its size limit')
          if (batch.length >= 64 || size + bytes > 4_000_000) await send()
          batch.push(value); size += bytes
        }
        await send()
      }
      // Queue before invoking fetch so another binder shares the same operation.
      const operation = Promise.resolve().then(initialize)
      for (const entry of fresh) responseInitializations.set(entry.key, operation)
      operation.finally(() => {
        for (const entry of fresh) if (responseInitializations.get(entry.key) === operation) responseInitializations.delete(entry.key)
      }).catch(() => {})
      pending.push(operation)
    }
    await Promise.all(pending)
  }

  // Auxiliary editors share the project room, but never the manuscript map.
  const namespacedTextFor = (namespace, key, initial = '', { readOnly = false } = {}) => {
    if (namespace !== 'rebuttalResponses') throw new Error('Unsupported text namespace')
    if (!bootstrapReady) throw new Error('Wait for collaboration synchronization before opening responses')
    const map = document.getMap(namespace)
    let text = map.get(key)
    if (!(text instanceof Y.Text)) {
      if (readOnly) return provisionalTextFor(`${namespace}\0${key}`, initial)
      throw new Error('Initialize shared responses before editing')
    }
    return text
  }
  const encodeTextRange = (text, start, end = start) => ({
    anchorRelative: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.max(0, Math.min(start, text.length))))),
    headRelative: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.max(0, Math.min(end, text.length)))))
  })

  let resolveReady
  let settleTimer
  const whenReady = new Promise(resolve => { resolveReady = resolve })
  Promise.all([persistence.whenSynced, initialServerSync]).then(() => {
    if (destroyed) return
    settleTimer = setTimeout(() => {
      bootstrapReady = true
      resolveReady({ status: 'ready' })
    }, bootstrapSettleMs)
  }, () => resolveReady({ status: 'failed' }))

  return {
    document,
    provider,
    persistence,
    textFor,
    namespacedTextFor,
    ensureNamespacedTexts,
    encodeTextRange,
    files,
    mapFor: name => document.getMap(name),
    setCursor,
    encodeRange,
    resolveRange,
    resolveCursor,
    isBootstrapLeader,
    updateActor,
    whenReady,
    destroy() {
      if (destroyed) return
      destroyed = true
      clearTimeout(settleTimer)
      initAbort.abort()
      resolveInitialServerSync()
      resolveReady({ status: 'destroyed' })
      awareness.off('change', awarenessChanged)
      disconnectedPeerClocks.clear()
      provider.destroy()
      persistence.destroy()
      for (const entry of provisionalFiles.values()) disposeFile(entry)
      provisionalFiles.clear()
      document.destroy()
    }
  }
}
