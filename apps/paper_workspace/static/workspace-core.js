(() => {
  function storedJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback))
    } catch (_) {
      localStorage.removeItem(key)
      return fallback
    }
  }

  const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const baseName = path => path.split('/').pop()
  const cleanSegment = value => value?.trim().replace(/[\\/]/g, '').replace(/^\.+$/, '').slice(0, 80)
  const constrain = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum)
  const extensionOf = path => {
    const name = baseName(path)
    return name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  }

  function normalizeState(value, initial = '') {
    const state = record(value)
    state.files = record(state.files)
    state.assets = record(state.assets)
    state.serverSourceSnapshots = record(state.serverSourceSnapshots)
    state.uploads = Array.isArray(state.uploads) ? state.uploads.filter(item => typeof item === 'string') : []
    state.comments = Array.isArray(state.comments) ? state.comments.filter(item => item && typeof item === 'object') : []
    state.tasks = Array.isArray(state.tasks) ? state.tasks.filter(item => item && typeof item === 'object') : []
    state.folders = Array.isArray(state.folders) ? state.folders.filter(item => typeof item === 'string') : []
    state.collapsedFolders = Array.isArray(state.collapsedFolders) ? state.collapsedFolders.filter(item => typeof item === 'string') : []
    if (typeof state.current !== 'string') state.current = 'paper/main.tex'

    if (!state.fileTreeVersion) {
      const migrated = {}
      for (const [name, content] of Object.entries(state.files)) migrated[name.includes('/') ? name : `paper/${name}`] = content
      state.files = migrated
      state.current = state.current?.includes('/') ? state.current : `paper/${state.current || 'main.tex'}`
      state.folders = ['paper', ...state.folders.filter(name => name !== 'paper')]
      state.fileTreeVersion = 1
    }
    state.files['paper/main.tex'] ??= initial
    if (!state.folders.length) state.folders = ['paper']
    if (!state.folders.includes('paper')) state.folders.unshift('paper')
    state.activeFolder = state.folders.includes(state.activeFolder) ? state.activeFolder : 'paper'
    return state
  }

  window.PaperWorkspaceCore = Object.freeze({
    baseName,
    cleanSegment,
    constrain,
    extensionOf,
    normalizeState,
    parentPath,
    storedJson
  })
})()
