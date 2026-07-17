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

export function createSession({ url, room, actor, onStatus, onPeers }) {
  const document = new Y.Doc()
  const persistence = new IndexeddbPersistence(`paper-workspace-crdt:${room}`, document)
  const provider = new WebsocketProvider(url, room, document, { connect: true })
  const files = document.getMap('files')
  const awareness = provider.awareness
  let bootstrapReady = false
  const bootstrapSettleMs = 400
  awareness.setLocalStateField('user', actor)

  provider.on('status', event => onStatus?.(event.status))
  provider.on('sync', synced => onStatus?.(synced ? 'synced' : 'connecting'))
  const publishPeers = () => {
    const peers = []
    awareness.getStates().forEach((state, clientId) => {
      if (clientId !== document.clientID && state.user) peers.push({ ...state.user, ...state.cursor, clientId })
    })
    onPeers?.(peers)
  }
  awareness.on('change', publishPeers)

  const isBootstrapLeader = () => Math.min(...awareness.getStates().keys()) === document.clientID
  const textFor = (path, initial = '') => {
    let text = files.get(path)
    if (!(text instanceof Y.Text)) {
      text = new Y.Text()
      files.set(path, text)
    }
    // Only seed after both persistence and the server have synchronized. When
    // several clients open an empty room together, the deterministic awareness
    // leader performs the initial insert so Yjs does not merge duplicate seeds.
    if (text.length === 0 && initial && bootstrapReady && isBootstrapLeader()) text.insert(0, initial)
    return text
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

  const resolveRange = range => {
    try {
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(range.anchorRelative)), document)
      const head = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(range.headRelative)), document)
      return anchor && head && anchor.type === head.type ? [anchor.index, head.index] : null
    } catch {
      return null
    }
  }

  const resolveCursor = peer => {
    try {
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(peer.anchor)), document)
      const head = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(peer.head)), document)
      if (!anchor || !head || anchor.type !== head.type) return null
      return [anchor.index, head.index]
    } catch {
      return null
    }
  }

  const updateActor = nextActor => {
    actor = nextActor
    awareness.setLocalStateField('user', actor)
  }

  return {
    document,
    provider,
    persistence,
    textFor,
    files,
    mapFor: name => document.getMap(name),
    setCursor,
    encodeRange,
    resolveRange,
    resolveCursor,
    isBootstrapLeader,
    updateActor,
    whenReady: Promise.all([
      persistence.whenSynced,
      new Promise(resolve => provider.once('sync', resolve))
    ]).then(() => new Promise(resolve => setTimeout(resolve, bootstrapSettleMs))).then(() => { bootstrapReady = true }),
    destroy() {
      awareness.off('change', publishPeers)
      provider.destroy()
      persistence.destroy()
      document.destroy()
    }
  }
}
