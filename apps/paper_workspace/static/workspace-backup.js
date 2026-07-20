(() => {
  'use strict'

  const { validProjectPath } = window.PaperWorkspaceCore

  function projectId(manifest) {
    const normalized = String(manifest?.id || 'default')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64)
    return normalized || 'default'
  }

  function snapshotItems(result) {
    if (Array.isArray(result)) return result
    if (Array.isArray(result?.snapshots)) return result.snapshots
    if (Array.isArray(result?.items)) return result.items
    return []
  }

  function extractSnapshot(result) {
    return result?.payload || result?.snapshot?.payload || result?.snapshot || result
  }

  function validateSnapshot(snapshot) {
    const files = snapshot?.files
    const validFiles = files &&
      typeof files === 'object' &&
      !Array.isArray(files) &&
      Object.keys(files).length > 0 &&
      Object.entries(files).every(([path, content]) => validProjectPath(path) && typeof content === 'string')
    if (!validFiles) throw new Error('백업의 원고 파일 형식이 올바르지 않습니다.')
    return {
      ...snapshot,
      title: typeof snapshot.title === 'string' ? snapshot.title.slice(0, 160) : '',
      files: { ...files },
      comments: Array.isArray(snapshot.comments) ? snapshot.comments : [],
      tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : []
    }
  }

  function compareFiles(previous, current) {
    const paths = [...new Set([...Object.keys(previous || {}), ...Object.keys(current || {})])].sort()
    const changed = paths.filter(path => previous?.[path] !== current?.[path])
    return {
      changed,
      added: changed.filter(path => previous?.[path] === undefined),
      removed: changed.filter(path => current?.[path] === undefined),
      modified: changed.filter(path => previous?.[path] !== undefined && current?.[path] !== undefined)
    }
  }

  window.PaperWorkspaceBackup = Object.freeze({
    compareFiles,
    extractSnapshot,
    projectId,
    snapshotItems,
    validateSnapshot
  })
})()
