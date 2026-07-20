(() => {
  'use strict'

  const { extensionOf } = window.PaperWorkspaceCore
  const sourceExtensions = new Set(['tex', 'bib', 'sty', 'bst', 'cls'])

  function validManifestPath(path) {
    return typeof path === 'string' &&
      path.length > 0 &&
      path.length <= 240 &&
      !path.startsWith('/') &&
      !path.split('/').some(part => !part || part === '.' || part === '..')
  }

  function validRuntimeFileRevisions(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value).every(([path, revision]) =>
        validManifestPath(path) && /^[0-9a-f]{64}$/.test(String(revision || ''))
      )
    )
  }

  function normalizeManifest(manifest) {
    const entrypoint = manifest?.entrypoint || 'main.tex'
    const previewEntrypoints = manifest?.preview_entrypoints ?? [entrypoint]
    const retiredPaths = manifest?.retired_paths ?? []
    const runtimeRevision = String(manifest?.runtime_revision ?? '')
    const runtimeFileRevisions = manifest?.runtime_file_revisions ?? {}
    const valid = manifest &&
      Array.isArray(manifest.files) &&
      validManifestPath(entrypoint) &&
      Array.isArray(previewEntrypoints) &&
      previewEntrypoints.every(path => validManifestPath(path) && path.endsWith('.tex')) &&
      Array.isArray(retiredPaths) &&
      retiredPaths.every(validManifestPath) &&
      (!manifest.preview_pdf || validManifestPath(manifest.preview_pdf)) &&
      (!manifest.preview_synctex || validManifestPath(manifest.preview_synctex)) &&
      (!runtimeRevision || /^[0-9a-f]{64}$/.test(runtimeRevision)) &&
      (!runtimeRevision || validRuntimeFileRevisions(runtimeFileRevisions))
    if (!valid) throw new Error('project.json 형식이 올바르지 않습니다.')
    for (const item of manifest.files) {
      if (!item || !validManifestPath(item.path) || (item.source && !validManifestPath(item.source))) {
        throw new Error('project.json에 잘못된 파일 경로가 있습니다.')
      }
    }
    return {
      ...manifest,
      entrypoint,
      preview_entrypoints: previewEntrypoints,
      retired_paths: retiredPaths,
      version: String(manifest.version || 'unversioned'),
      runtime_revision: runtimeRevision,
      runtime_file_revisions: runtimeFileRevisions
    }
  }

  function manifestItemIsAsset(item) {
    return item.type === 'asset' && !sourceExtensions.has(extensionOf(item.path))
  }

  function serverManagedManifestItems(manifest) {
    const entrypoint = manifest.entrypoint || 'main.tex'
    return manifest.files.filter(item => !manifestItemIsAsset(item) && (item.managed || item.path === entrypoint))
  }

  function runtimeFileRevision(manifest, path) {
    const value = manifest?.runtime_file_revisions?.[path]
    return /^[0-9a-f]{64}$/.test(String(value || '')) ? String(value) : ''
  }

  function projectFileUrl(projectBase, path, manifest) {
    const encodedPath = String(path).split('/').map(encodeURIComponent).join('/')
    const revision = runtimeFileRevision(manifest, path)
    const base = `${projectBase}/project/${encodedPath}`
    return revision ? `${base}?v=${revision.slice(0, 16)}` : base
  }

  window.PaperWorkspaceProject = Object.freeze({
    manifestItemIsAsset,
    normalizeManifest,
    projectFileUrl,
    runtimeFileRevision,
    serverManagedManifestItems,
    validManifestPath,
    validRuntimeFileRevisions
  })
})()
