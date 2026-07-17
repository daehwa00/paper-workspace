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
  const cleanSegment = value => value?.trim().replace(/[^\p{L}\p{N}._() -]/gu, '').replace(/^\.+$/, '').slice(0, 80)
  const constrain = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum)
  const extensionOf = path => {
    const name = baseName(path)
    return name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  }
  const validProjectPath = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..' && ![...part].some(character => character.charCodeAt(0) < 32))
  const stringRecord = value => Object.fromEntries(Object.entries(record(value)).filter(([path, content]) => validProjectPath(path) && typeof content === 'string'))

  function normalizeState(value, initial = '') {
    const state = record(value)
    state.files = stringRecord(state.files)
    state.assets = Object.fromEntries(Object.entries(record(state.assets)).filter(([path, asset]) => validProjectPath(path) && asset && typeof asset === 'object' && !Array.isArray(asset)))
    state.serverSourceSnapshots = stringRecord(state.serverSourceSnapshots)
    state.uploads = Array.isArray(state.uploads) ? state.uploads.filter(validProjectPath) : []
    state.comments = Array.isArray(state.comments) ? state.comments.filter(item => item && typeof item === 'object') : []
    state.tasks = Array.isArray(state.tasks) ? state.tasks.filter(item => item && typeof item === 'object') : []
    state.folders = Array.isArray(state.folders) ? state.folders.filter(validProjectPath) : []
    state.collapsedFolders = Array.isArray(state.collapsedFolders) ? state.collapsedFolders.filter(validProjectPath) : []
    if (!validProjectPath(state.current)) state.current = 'paper/main.tex'

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
