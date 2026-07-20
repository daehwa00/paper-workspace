(() => {
  'use strict'

  const {
    compactSourceSnapshot,
    normalizeState,
    validProjectPath
  } = window.PaperWorkspaceCore

  const defaultTimeoutMs = 2000
  const defaultRecoveryCharacterLimit = 512 * 1024

  function storageTimeout(label) {
    return new DOMException(`${label} timed out`, 'TimeoutError')
  }

  function withTimeout(promise, timeoutMs = defaultTimeoutMs, label = 'browser storage') {
    const duration = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 50
      ? Number(timeoutMs)
      : defaultTimeoutMs
    let timer = 0
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(storageTimeout(label)), duration)
    })
    return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer))
  }

  function openDatabase(name, storeName, upgrade) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => upgrade(request.result)
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(`${storeName} database upgrade blocked`))
    })
  }

  async function transact(database, storeName, mode, operation, timeoutMs) {
    const db = await withTimeout(database, timeoutMs, `${storeName} database open`)
    const result = new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode)
      const request = operation(transaction.objectStore(storeName))
      let value = null
      request.onsuccess = () => { value = request.result ?? null }
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => resolve(value)
      transaction.onabort = () => reject(transaction.error || new Error(`${storeName} transaction aborted`))
    })
    return withTimeout(result, timeoutMs, `${storeName} transaction`)
  }

  function workspaceStateStore(name = 'paper-workspace-state', { timeoutMs = defaultTimeoutMs } = {}) {
    const database = openDatabase(name, 'states', db => {
      if (!db.objectStoreNames.contains('states')) db.createObjectStore('states', { keyPath: 'project' })
    })
    return Object.freeze({
      get: project => transact(database, 'states', 'readonly', store => store.get(project), timeoutMs),
      put: (project, state, savedAt = Date.now()) => transact(
        database,
        'states',
        'readwrite',
        store => store.put({ project, state, savedAt }),
        timeoutMs
      )
    })
  }

  function workspaceAssetStore(project, name = 'paper-workspace-assets', { timeoutMs = defaultTimeoutMs } = {}) {
    const database = openDatabase(name, 'assets', db => {
      if (db.objectStoreNames.contains('assets')) return
      const store = db.createObjectStore('assets', { keyPath: 'key' })
      store.createIndex('project', 'project')
    })
    const key = path => `${project}:${path}`
    return Object.freeze({
      delete: path => transact(database, 'assets', 'readwrite', store => store.delete(key(path)), timeoutMs),
      list: () => transact(database, 'assets', 'readonly', store => store.index('project').getAll(project), timeoutMs),
      put: (path, asset) => transact(database, 'assets', 'readwrite', store => store.put({
        key: key(path),
        project,
        path,
        asset: {
          type: asset.type,
          size: asset.size,
          data: asset.data
        }
      }), timeoutMs)
    })
  }

  function createLatestWriteQueue(writer) {
    let pending = null
    let running = false
    let active = Promise.resolve()

    const start = () => {
      if (running || pending === null) return
      running = true
      active = (async () => {
        while (pending !== null) {
          const value = pending
          pending = null
          await writer(value)
        }
      })().finally(() => {
        running = false
        if (pending !== null) start()
      })
    }

    return Object.freeze({
      push(value) {
        pending = value
        start()
      },
      async drain() {
        do {
          await active
        } while (running || pending !== null)
      }
    })
  }

  function validRecovery(value, characterLimit) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      validProjectPath(value.path) &&
      value.path.startsWith('paper/') &&
      typeof value.content === 'string' &&
      Number.isFinite(Number(value.savedAt)) &&
      value.content.length <= characterLimit
    )
  }

  function createWorkspacePersistence({
    project,
    storageKey,
    parsedState,
    state,
    initial = '',
    hadLegacyFiles = false,
    legacyKeys = [],
    ensureState = () => {},
    snapshot,
    compactSnapshot,
    setStatus = () => {},
    reportError = () => {},
    timeoutMs = defaultTimeoutMs,
    recoveryCharacterLimit = defaultRecoveryCharacterLimit
  }) {
    const store = workspaceStateStore('paper-workspace-state', { timeoutMs })
    let available = false
    let savedAt = 0
    let generation = 0
    let issuedAt = 0

    const replaceState = next => {
      for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, normalizeState(structuredClone(next), initial))
      ensureState()
    }
    const recovery = parsedState?.recovery
    const hasRecovery = () => validRecovery(recovery, recoveryCharacterLimit)
    const applyRecovery = target => {
      if (!hasRecovery()) return false
      target.files[recovery.path] = recovery.content
      target.current = recovery.path
      return true
    }
    const metadata = (currentSnapshot, timestamp) => {
      const current = currentSnapshot.current && currentSnapshot.files?.[currentSnapshot.current] !== undefined
        ? currentSnapshot.current
        : 'paper/main.tex'
      const content = String(currentSnapshot.files?.[current] ?? '')
      return {
        browserStateVersion: 2,
        indexedSavedAt: timestamp,
        fileTreeVersion: currentSnapshot.fileTreeVersion || 1,
        fileTreePreferencesVersion: currentSnapshot.fileTreePreferencesVersion || 1,
        current,
        activeFolder: currentSnapshot.activeFolder || 'paper',
        folders: Array.isArray(currentSnapshot.folders) ? currentSnapshot.folders : [],
        collapsedFolders: Array.isArray(currentSnapshot.collapsedFolders) ? currentSnapshot.collapsedFolders : [],
        projectTitle: currentSnapshot.projectTitle || '',
        projectVersion: currentSnapshot.projectVersion || '',
        serverMainSnapshot: compactSourceSnapshot(currentSnapshot.serverMainSnapshot),
        serverSourceSnapshots: Object.fromEntries(Object.entries(currentSnapshot.serverSourceSnapshots || {})
          .map(([path, value]) => [path, compactSourceSnapshot(value)])),
        recovery: content.length <= recoveryCharacterLimit ? { path: current, content, savedAt: timestamp } : null
      }
    }
    const persistMetadata = (currentSnapshot, timestamp) => {
      const encoded = JSON.stringify(metadata(currentSnapshot, timestamp))
      for (const key of legacyKeys) localStorage.removeItem(key)
      try {
        localStorage.setItem(storageKey, encoded)
      } catch {
        localStorage.removeItem(storageKey)
        localStorage.setItem(storageKey, encoded)
      }
    }
    const savedLabel = synced => synced ? '저장됨 · 공동 편집 동기화' : '로컬 저장됨 · 동기화 대기'
    const fallbackSave = synced => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(snapshot()))
        setStatus(savedLabel(synced))
        return true
      } catch {
        try {
          localStorage.setItem(storageKey, JSON.stringify(compactSnapshot()))
          setStatus('로컬 저장됨 · 오래된 초안 제외')
          return true
        } catch {
          setStatus('저장 공간 부족')
          return false
        }
      }
    }

    const writes = createLatestWriteQueue(async write => {
      try {
        await store.put(project, write.snapshot, write.savedAt)
        savedAt = write.savedAt
        if (write.generation === generation) setStatus(savedLabel(write.synced))
      } catch (error) {
        if (write.generation === generation) setStatus('브라우저 저장 오류')
        reportError(error, 'persistIndexedWorkspaceState')
      }
    })

    return Object.freeze({
      async initialize() {
        try {
          const record = await store.get(project)
          if (record?.state && typeof record.state === 'object') {
            const restored = normalizeState(structuredClone(record.state), initial)
            if (hasRecovery() && Number(recovery.savedAt) > Number(record.savedAt || 0)) applyRecovery(restored)
            replaceState(restored)
            savedAt = Number(record.savedAt) || 0
          } else if (hadLegacyFiles || hasRecovery()) {
            if (!hadLegacyFiles) applyRecovery(state)
            const timestamp = Date.now()
            const currentSnapshot = snapshot()
            await store.put(project, currentSnapshot, timestamp)
            savedAt = timestamp
          }
          available = true
          try {
            persistMetadata(snapshot(), savedAt || Date.now())
          } catch (error) {
            reportError(error, 'persistLocalWorkspaceMetadata')
          }
          return true
        } catch (error) {
          available = false
          applyRecovery(state)
          reportError(error, 'initializeIndexedWorkspaceState')
          return false
        }
      },
      save({ synced = false } = {}) {
        if (!available) return fallbackSave(synced)
        const currentGeneration = ++generation
        issuedAt = Math.max(Date.now(), issuedAt + 1)
        const currentSnapshot = structuredClone(snapshot())
        try {
          persistMetadata(currentSnapshot, issuedAt)
        } catch (error) {
          reportError(error, 'persistLocalWorkspaceMetadata')
        }
        setStatus('브라우저 저장 중…')
        writes.push({
          generation: currentGeneration,
          savedAt: issuedAt,
          snapshot: currentSnapshot,
          synced
        })
        return true
      },
      drain: () => writes.drain(),
      isAvailable: () => available
    })
  }

  window.PaperWorkspaceStorage = Object.freeze({
    createLatestWriteQueue,
    createWorkspacePersistence,
    validRecovery,
    withTimeout,
    workspaceAssetStore,
    workspaceStateStore
  })
})()
