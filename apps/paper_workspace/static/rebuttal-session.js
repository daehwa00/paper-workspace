// A shared provider and Y.Doc may outlive the iframe that observes them.
export function createSessionBindings(page) {
  const cleanups = new Set()
  let closed = false
  function add(cleanup) {
    if (closed) cleanup()
    else cleanups.add(cleanup)
  }
  function close() {
    closed = true
    for (const cleanup of cleanups) cleanup()
    cleanups.clear()
  }
  // A cached page can resume using its existing observers. A real unload
  // drops the child frame while leaving the parent collaboration session alive.
  page.addEventListener('pagehide', event => { if (!event.persisted) close() })
  page.addEventListener('unload', close, {once: true})
  return {
    get closed() { return closed },
    add,
    observe(target, listener) {
      if (closed) return
      target.observe(listener)
      add(() => target.unobserve(listener))
    },
    on(target, event, listener) {
      if (closed || !target) return
      target.on(event, listener)
      add(() => target.off(event, listener))
    }
  }
}

export function createTextHashCache() {
  const cache = new Map()
  const encoder = new TextEncoder()
  return function textHash(value) {
    if (cache.has(value)) return cache.get(value)
    const result = crypto.subtle.digest('SHA-256', encoder.encode(value))
      .then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''))
    cache.set(value, result)
    if (cache.size > 100) cache.delete(cache.keys().next().value)
    return result
  }
}

// Persist changes arriving while a revision request is in flight before
// handing control back to an analysis or submission action.
export function createResponseRevisionSync({enabled, isBusy, persist, onError}) {
  const pending = new Set()
  let timer, operation
  async function drain() {
    while (enabled() && pending.size) {
      const ids = new Set(pending)
      pending.clear()
      try { await persist(ids) }
      catch (error) {
        for (const id of ids) pending.add(id)
        throw error
      }
    }
  }
  async function flush() {
    clearTimeout(timer)
    while (enabled() && (operation || pending.size)) {
      operation ||= Promise.resolve().then(drain).finally(() => { operation = null })
      await operation
    }
  }
  function schedule(delay) {
    clearTimeout(timer)
    if (!enabled()) return
    timer = setTimeout(async () => {
      if (isBusy()) { schedule(1200); return }
      try { await flush() }
      catch (error) { if (enabled()) { onError(error); schedule(3000) } }
    }, delay)
  }
  return {
    pending,
    get flushing() { return Boolean(operation) },
    queue(id, urgent = false) {
      if (!enabled()) return
      pending.add(id)
      schedule(urgent ? 0 : 1200)
    },
    flush,
    cancel() { clearTimeout(timer) }
  }
}
