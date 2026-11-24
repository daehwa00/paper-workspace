(() => {
  'use strict'

  const {compactSourceSnapshot, normalizeState, validProjectPath} = window.PaperWorkspaceCore
  const defaultTimeoutMs = 2000
  const defaultRecoveryLimit = 512 * 1024

  function withTimeout(promise, timeoutMs, label) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException(`${label} timed out`, 'TimeoutError')), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }

  function compareAndPut(store, record, expectedSavedAt) {
    const request = store.get(record.project)
    const result = {result: false}
    request.onsuccess = () => {
      const previous = Number(request.result?.savedAt) || 0
      if (previous >= record.savedAt || (expectedSavedAt !== undefined && previous !== expectedSavedAt)) return
      store.put(record)
      result.result = true
    }
    return result
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
    return withTimeout(new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode)
      const request = operation(transaction.objectStore(storeName))
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => resolve(request.result ?? null)
      transaction.onabort = () => reject(transaction.error || new Error(`${storeName} transaction aborted`))
    }), timeoutMs, `${storeName} transaction`)
  }

  function workspaceStateStore(name = 'paper-workspace-state', {timeoutMs = defaultTimeoutMs} = {}) {
    const database = openDatabase(name, 'states', db => {
      if (!db.objectStoreNames.contains('states')) db.createObjectStore('states', {keyPath: 'project'})
    })
    return {
      get: project => transact(database, 'states', 'readonly', store => store.get(project), timeoutMs),
      put: (project, state, savedAt = Date.now(), expectedSavedAt) => transact(database, 'states', 'readwrite', store => compareAndPut(store, {project, state, savedAt}, expectedSavedAt), timeoutMs)
    }
  }

  function workspaceAssetStore(project, name = 'paper-workspace-assets', {timeoutMs = defaultTimeoutMs} = {}) {
    const database = openDatabase(name, 'assets', db => {
      if (db.objectStoreNames.contains('assets')) return
      const store = db.createObjectStore('assets', {keyPath: 'key'})
      store.createIndex('project', 'project')
    })
    const key = path => `${project}:${path}`
    return {
      delete: path => transact(database, 'assets', 'readwrite', store => store.delete(key(path)), timeoutMs),
      list: () => transact(database, 'assets', 'readonly', store => store.index('project').getAll(project), timeoutMs),
      put: (path, asset) => transact(database, 'assets', 'readwrite', store => store.put({key: key(path), project, path, asset: {type: asset.type, size: asset.size, data: asset.data}}), timeoutMs)
    }
  }

  function createLatestWriteQueue(writer) {
    let pending = null
    let active = Promise.resolve()
    let running = false
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
        start()
      })
    }
    return {
      push(value) { pending = value; start() },
      async drain() { do await active; while (running || pending !== null) }
    }
  }

  function validRecovery(value, limit) {
    return Boolean(value && typeof value === 'object' && validProjectPath(value.path) && value.path.startsWith('paper/') && typeof value.content === 'string' && Number.isFinite(Number(value.savedAt)) && value.content.length <= limit)
  }

  function createWorkspacePersistence({
    project, storageKey, parsedState, state, initial = '', hadLegacyFiles = false,
    legacyKeys = [], ensureState = () => {}, snapshot, compactSnapshot,
    setStatus = () => {}, reportError = () => {}, timeoutMs = defaultTimeoutMs,
    recoveryCharacterLimit = defaultRecoveryLimit
  }) {
    const store = workspaceStateStore('paper-workspace-state', {timeoutMs})
    const recovery = parsedState?.recovery
    const recoveryValid = validRecovery(recovery, recoveryCharacterLimit)
    let available = false
    let generation = 0
    let issuedAt = 0
    let committedAt = 0

    const applyRecovery = target => {
      if (!recoveryValid) return
      target.files[recovery.path] = recovery.content
      target.current = recovery.path
    }
    const replaceState = next => {
      for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, normalizeState(structuredClone(next), initial))
      ensureState()
    }
    const metadata = (currentSnapshot, savedAt, baseSavedAt) => {
      const current = currentSnapshot.current && currentSnapshot.files?.[currentSnapshot.current] !== undefined ? currentSnapshot.current : 'paper/main.tex'
      const content = String(currentSnapshot.files?.[current] ?? '')
      return {
        browserStateVersion: 2, indexedSavedAt: baseSavedAt,
        fileTreeVersion: currentSnapshot.fileTreeVersion || 1,
        fileTreePreferencesVersion: currentSnapshot.fileTreePreferencesVersion || 1,
        current, activeFolder: currentSnapshot.activeFolder || 'paper',
        commentCount: Array.isArray(currentSnapshot.comments) ? currentSnapshot.comments.length : 0,
        openTaskCount: Array.isArray(currentSnapshot.tasks) ? currentSnapshot.tasks.filter(task => !task.done).length : 0,
        folders: Array.isArray(currentSnapshot.folders) ? currentSnapshot.folders : [],
        collapsedFolders: Array.isArray(currentSnapshot.collapsedFolders) ? currentSnapshot.collapsedFolders : [],
        projectTitle: currentSnapshot.projectTitle || '', projectVersion: currentSnapshot.projectVersion || '',
        serverMainSnapshot: compactSourceSnapshot(currentSnapshot.serverMainSnapshot),
        serverSourceSnapshots: Object.fromEntries(Object.entries(currentSnapshot.serverSourceSnapshots || {}).map(([path, value]) => [path, compactSourceSnapshot(value)])),
        recovery: content.length <= recoveryCharacterLimit ? {path: current, content, savedAt, baseSavedAt} : null
      }
    }
    const persistMetadata = (currentSnapshot, savedAt, baseSavedAt = savedAt) => {
      const existing = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (Number(existing?.indexedSavedAt) > baseSavedAt) return
      const encoded = JSON.stringify(metadata(currentSnapshot, savedAt, baseSavedAt))
      for (const key of legacyKeys) localStorage.removeItem(key)
      try { localStorage.setItem(storageKey, encoded) } catch {
        localStorage.removeItem(storageKey)
        localStorage.setItem(storageKey, encoded)
      }
    }
    const savedLabel = synced => synced ? '저장됨 · 공동 편집 동기화' : '로컬 저장됨 · 동기화 대기'
    const fallbackSave = synced => {
      for (const [value, status] of [[snapshot(), savedLabel(synced)], [compactSnapshot(), '로컬 저장됨 · 오래된 초안 제외']]) {
        try { localStorage.setItem(storageKey, JSON.stringify(value)); setStatus(status); return true } catch {}
      }
      setStatus('저장 공간 부족')
      return false
    }
    const writes = createLatestWriteQueue(async write => {
      try {
        if (!await store.put(project, write.snapshot, write.savedAt, committedAt)) {
          if (write.generation === generation) setStatus('다른 탭에서 저장됨 · 현재 탭의 변경 내용 유지 중')
          return
        }
        committedAt = write.savedAt
        if (write.generation === generation) {
          try { persistMetadata(write.snapshot, committedAt) } catch (error) { reportError(error, 'persistLocalWorkspaceMetadata') }
          setStatus(savedLabel(write.synced))
        }
      } catch (error) {
        if (write.generation === generation) setStatus('브라우저 저장 오류')
        reportError(error, 'persistIndexedWorkspaceState')
      }
    })

    return {
      async initialize() {
        try {
          const record = await store.get(project)
          let restoredAt = 0
          if (record?.state && typeof record.state === 'object') {
            const restored = normalizeState(structuredClone(record.state), initial)
            const recordSavedAt = Number(record.savedAt) || 0
            if (recoveryValid && Number(recovery.savedAt) > recordSavedAt &&
                (recovery.baseSavedAt === undefined || recovery.baseSavedAt === recordSavedAt)) applyRecovery(restored)
            replaceState(restored)
            restoredAt = recordSavedAt
          } else if (hadLegacyFiles || recoveryValid) {
            if (!hadLegacyFiles) applyRecovery(state)
            restoredAt = Date.now()
            if (!await store.put(project, snapshot(), restoredAt, 0)) {
              const newer = await store.get(project)
              replaceState(newer.state)
              restoredAt = Number(newer.savedAt) || 0
            }
          }
          issuedAt = committedAt = restoredAt
          available = true
          if (restoredAt) {
            const savedAt = recoveryValid && Number(recovery.savedAt) > restoredAt && (recovery.baseSavedAt === undefined || recovery.baseSavedAt === restoredAt)
              ? Number(recovery.savedAt) : restoredAt
            issuedAt = savedAt
            try { persistMetadata(snapshot(), savedAt, restoredAt) } catch (error) { reportError(error, 'persistLocalWorkspaceMetadata') }
          }
          return true
        } catch (error) {
          applyRecovery(state)
          reportError(error, 'initializeIndexedWorkspaceState')
          return false
        }
      },
      save({synced = false, keepRecovery = false} = {}) {
        if (!available) return fallbackSave(synced)
        const currentSnapshot = structuredClone(snapshot())
        const savedAt = issuedAt = Math.max(Date.now(), issuedAt + 1)
        const currentGeneration = ++generation
        if (keepRecovery) {
          // Navigation can close the page before the IndexedDB transaction completes.
          try { persistMetadata(currentSnapshot, savedAt, committedAt) } catch (error) { reportError(error, 'persistLocalWorkspaceMetadata') }
        }
        setStatus('브라우저 저장 중…')
        writes.push({generation: currentGeneration, savedAt, snapshot: currentSnapshot, synced})
        return true
      }
    }
  }

  window.PaperWorkspaceStorage = Object.freeze({createLatestWriteQueue, createWorkspacePersistence, workspaceAssetStore, workspaceStateStore})
})()
