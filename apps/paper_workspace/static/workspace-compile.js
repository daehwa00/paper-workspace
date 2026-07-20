(() => {
  'use strict'

  const { extensionOf } = window.PaperWorkspaceCore
  const textExtensions = new Set(['tex', 'bib', 'sty', 'bst', 'cls', 'csv', 'txt', 'json', 'dat'])
  const assetExtensions = new Set(['png', 'jpg', 'jpeg', 'pdf', 'eps'])

  async function parallelLimit(items, limit, worker) {
    let index = 0
    const run = async () => {
      while (index < items.length) await worker(items[index++])
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  }

  async function buildCompilePayload({
    files: workspaceFiles,
    assets: workspaceAssets,
    entrypoint,
    rootEntrypoint,
    previewMode,
    workspaceId,
    ensureAssetLoaded
  }) {
    const files = {}
    for (const [path, content] of Object.entries(workspaceFiles)) {
      if (!path.startsWith('paper/')) continue
      const relative = path.slice('paper/'.length)
      if (relative.startsWith('drafts/') && relative !== entrypoint) continue
      if (textExtensions.has(extensionOf(relative))) files[relative] = content
    }
    files['main.tex'] = workspaceFiles['paper/main.tex']

    const assets = {}
    const paths = Object.keys(workspaceAssets).filter(path =>
      path.startsWith('paper/') && assetExtensions.has(extensionOf(path))
    )
    await parallelLimit(paths, 4, ensureAssetLoaded)
    for (const path of paths) {
      const data = workspaceAssets[path].data
      assets[path.slice('paper/'.length)] = data.slice(data.indexOf(',') + 1)
    }
    return {
      files,
      assets,
      entrypoint,
      root_entrypoint: rootEntrypoint,
      preview_mode: previewMode,
      workspace_id: workspaceId
    }
  }

  async function compilePayloadFingerprint(payload) {
    const { build_mode: ignoredBuildMode, ...contentPayload } = payload
    const ordered = {
      ...contentPayload,
      files: Object.fromEntries(Object.entries(contentPayload.files).sort(([left], [right]) => left.localeCompare(right))),
      assets: Object.fromEntries(Object.entries(contentPayload.assets).sort(([left], [right]) => left.localeCompare(right)))
    }
    const encoded = new TextEncoder().encode(JSON.stringify(ordered))
    const digest = await crypto.subtle.digest('SHA-256', encoded)
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  function parseLatexDiagnostics(message, entrypoint) {
    const text = String(message || '')
    const diagnostics = []
    const lineMatches = [...text.matchAll(/(?:^|\n)l\.(\d+)\s*([^\n]*)/g)]
    for (const match of text.matchAll(/File `([^']+)' not found(?:[^\n]*input line (\d+))?/g)) {
      diagnostics.push({
        file: `paper/${entrypoint}`,
        line: Number(match[2]) || Number(lineMatches.at(-1)?.[1]) || 1,
        message: `필요한 파일이 프로젝트에 없습니다: ${match[1]}`
      })
    }
    for (const match of text.matchAll(/LaTeX Error:\s*([^\n]+)/g)) {
      diagnostics.push({
        file: `paper/${entrypoint}`,
        line: Number(lineMatches.at(-1)?.[1]) || 1,
        message: match[1].trim()
      })
    }
    if (!diagnostics.length) {
      for (const match of lineMatches.slice(-8)) {
        diagnostics.push({
          file: `paper/${entrypoint}`,
          line: Number(match[1]),
          message: (match[2] || 'LaTeX 오류가 발생했습니다.').trim()
        })
      }
    }
    if (!diagnostics.length) {
      diagnostics.push({
        file: `paper/${entrypoint}`,
        line: 1,
        message: text.split('\n').filter(Boolean).at(-1) || '컴파일 오류'
      })
    }
    return diagnostics.slice(-10)
  }

  window.PaperWorkspaceCompile = Object.freeze({
    buildCompilePayload,
    compilePayloadFingerprint,
    parseLatexDiagnostics
  })
})()
