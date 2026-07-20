(() => {
  'use strict'

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

  function storedJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback))
    } catch {
      localStorage.removeItem(key)
      return fallback
    }
  }

  function sourceFingerprint(value) {
    let first = 2166136261
    let second = 2246822507
    const source = String(value ?? '')
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index)
      first = Math.imul(first ^ code, 16777619)
      second = Math.imul(second ^ code, 3266489917)
    }
    return `fp1:${source.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`
  }

  const compactSourceSnapshot = value => typeof value !== 'string' || !value ? '' : value.startsWith('fp1:') ? value : sourceFingerprint(value)
  const sourceSnapshotMatches = (snapshot, source) => snapshot === source || snapshot === sourceFingerprint(source)

  function normalizeState(value, initial = '') {
    const state = record(value)
    state.files = stringRecord(state.files)
    state.assets = Object.fromEntries(Object.entries(record(state.assets)).filter(([path, asset]) => validProjectPath(path) && record(asset) === asset))
    state.serverSourceSnapshots = stringRecord(state.serverSourceSnapshots)
    state.uploads = Array.isArray(state.uploads) ? state.uploads.filter(validProjectPath) : []
    state.comments = Array.isArray(state.comments) ? state.comments.filter(item => record(item) === item) : []
    state.tasks = Array.isArray(state.tasks) ? state.tasks.filter(item => record(item) === item) : []
    state.folders = Array.isArray(state.folders) ? state.folders.filter(validProjectPath) : []
    state.collapsedFolders = Array.isArray(state.collapsedFolders) ? state.collapsedFolders.filter(validProjectPath) : []
    if (!validProjectPath(state.current)) state.current = 'paper/main.tex'
    if (!state.fileTreeVersion) {
      state.files = Object.fromEntries(Object.entries(state.files).map(([name, content]) => [name.includes('/') ? name : `paper/${name}`, content]))
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

  const sourceExtensions = new Set(['tex', 'bib', 'sty', 'bst', 'cls'])
  const manifestItemIsAsset = item => item.type === 'asset' && !sourceExtensions.has(extensionOf(item.path))
  const validRevisions = value => record(value) === value && Object.entries(value).every(([path, revision]) => validProjectPath(path) && /^[0-9a-f]{64}$/.test(String(revision || '')))

  function normalizeManifest(manifest) {
    const entrypoint = manifest?.entrypoint || 'main.tex'
    const previews = manifest?.preview_entrypoints ?? [entrypoint]
    const retired = manifest?.retired_paths ?? []
    const revision = String(manifest?.runtime_revision ?? '')
    const revisions = manifest?.runtime_file_revisions ?? {}
    const pathsValid = Array.isArray(manifest?.files) && manifest.files.every(item => item && validProjectPath(item.path) && (!item.source || validProjectPath(item.source)))
    const metadataValid = validProjectPath(entrypoint) && Array.isArray(previews) && previews.every(path => validProjectPath(path) && path.endsWith('.tex')) && Array.isArray(retired) && retired.every(validProjectPath) && (!manifest.preview_pdf || validProjectPath(manifest.preview_pdf)) && (!manifest.preview_synctex || validProjectPath(manifest.preview_synctex)) && (!revision || /^[0-9a-f]{64}$/.test(revision) && validRevisions(revisions))
    if (!pathsValid || !metadataValid) throw new Error('project.json 형식이 올바르지 않습니다.')
    return {...manifest, entrypoint, preview_entrypoints: previews, retired_paths: retired, version: String(manifest.version || 'unversioned'), runtime_revision: revision, runtime_file_revisions: revisions}
  }

  function serverManagedManifestItems(manifest) {
    const entrypoint = manifest.entrypoint || 'main.tex'
    return manifest.files.filter(item => !manifestItemIsAsset(item) && (item.managed || item.path === entrypoint))
  }

  function runtimeFileRevision(manifest, path) {
    const revision = String(manifest?.runtime_file_revisions?.[path] || '')
    return /^[0-9a-f]{64}$/.test(revision) ? revision : ''
  }

  function projectFileUrl(projectBase, path, manifest) {
    const base = `${projectBase}/project/${String(path).split('/').map(encodeURIComponent).join('/')}`
    const revision = runtimeFileRevision(manifest, path)
    return revision ? `${base}?v=${revision.slice(0, 16)}` : base
  }

  const compileTextExtensions = new Set(['tex', 'bib', 'sty', 'bst', 'cls', 'csv', 'txt', 'json', 'dat'])
  const compileAssetExtensions = new Set(['png', 'jpg', 'jpeg', 'pdf', 'eps'])
  async function parallelLimit(items, limit, worker) {
    let index = 0
    const run = async () => { while (index < items.length) await worker(items[index++]) }
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, run))
  }

  async function buildCompilePayload({files: workspaceFiles, assets: workspaceAssets, entrypoint, rootEntrypoint, previewMode, workspaceId, ensureAssetLoaded}) {
    const files = {}
    for (const [path, content] of Object.entries(workspaceFiles)) {
      if (!path.startsWith('paper/')) continue
      const relative = path.slice(6)
      if (!relative.startsWith('drafts/') || relative === entrypoint) {
        if (compileTextExtensions.has(extensionOf(relative))) files[relative] = content
      }
    }
    files['main.tex'] = workspaceFiles['paper/main.tex']
    const assets = {}
    const paths = Object.keys(workspaceAssets).filter(path => path.startsWith('paper/') && compileAssetExtensions.has(extensionOf(path)))
    await parallelLimit(paths, 4, ensureAssetLoaded)
    for (const path of paths) {
      const data = workspaceAssets[path].data
      assets[path.slice(6)] = data.slice(data.indexOf(',') + 1)
    }
    return {files, assets, entrypoint, root_entrypoint: rootEntrypoint, preview_mode: previewMode, workspace_id: workspaceId}
  }

  async function compilePayloadFingerprint(payload) {
    const {build_mode: ignored, ...content} = payload
    const ordered = {...content, files: Object.fromEntries(Object.entries(content.files).sort()), assets: Object.fromEntries(Object.entries(content.assets).sort())}
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ordered)))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  function parseLatexDiagnostics(message, entrypoint) {
    const text = String(message || '')
    const lines = [...text.matchAll(/(?:^|\n)l\.(\d+)\s*([^\n]*)/g)]
    const diagnostics = [...text.matchAll(/File `([^']+)' not found(?:[^\n]*input line (\d+))?/g)].map(match => ({file: `paper/${entrypoint}`, line: Number(match[2]) || Number(lines.at(-1)?.[1]) || 1, message: `필요한 파일이 프로젝트에 없습니다: ${match[1]}`}))
    for (const match of text.matchAll(/LaTeX Error:\s*([^\n]+)/g)) diagnostics.push({file: `paper/${entrypoint}`, line: Number(lines.at(-1)?.[1]) || 1, message: match[1].trim()})
    if (!diagnostics.length) diagnostics.push(...lines.slice(-8).map(match => ({file: `paper/${entrypoint}`, line: Number(match[1]), message: (match[2] || 'LaTeX 오류가 발생했습니다.').trim()})))
    if (!diagnostics.length) diagnostics.push({file: `paper/${entrypoint}`, line: 1, message: text.split('\n').filter(Boolean).at(-1) || '컴파일 오류'})
    return diagnostics.slice(-10)
  }

  function backupProjectId(manifest) {
    return String(manifest?.id || 'default').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'default'
  }
  const backupItems = result => Array.isArray(result) ? result : Array.isArray(result?.snapshots) ? result.snapshots : Array.isArray(result?.items) ? result.items : []
  const extractBackupSnapshot = result => result?.payload || result?.snapshot?.payload || result?.snapshot || result

  function validateBackupSnapshot(snapshot) {
    const files = snapshot?.files
    if (record(files) !== files || !Object.keys(files).length || !Object.entries(files).every(([path, content]) => validProjectPath(path) && typeof content === 'string')) throw new Error('백업의 원고 파일 형식이 올바르지 않습니다.')
    return {...snapshot, title: typeof snapshot.title === 'string' ? snapshot.title.slice(0, 160) : '', files: {...files}, comments: Array.isArray(snapshot.comments) ? snapshot.comments : [], tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : []}
  }

  function compareBackupFiles(previous, current) {
    const changed = [...new Set([...Object.keys(previous || {}), ...Object.keys(current || {})])].sort().filter(path => previous?.[path] !== current?.[path])
    return {changed, added: changed.filter(path => previous?.[path] === undefined), removed: changed.filter(path => current?.[path] === undefined), modified: changed.filter(path => previous?.[path] !== undefined && current?.[path] !== undefined)}
  }

  window.PaperWorkspaceCore = Object.freeze({
    backupItems, backupProjectId, baseName, buildCompilePayload, cleanSegment, compactSourceSnapshot,
    compareBackupFiles, compilePayloadFingerprint, constrain, extensionOf, extractBackupSnapshot,
    manifestItemIsAsset, normalizeManifest, normalizeState, parentPath, parseLatexDiagnostics,
    projectFileUrl, runtimeFileRevision, serverManagedManifestItems, sourceFingerprint,
    sourceSnapshotMatches, storedJson, validateBackupSnapshot, validProjectPath
  })
})()
