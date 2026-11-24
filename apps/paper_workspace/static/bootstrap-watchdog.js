(() => {
  let startupReady = false
  window.__paperMarkStartupReady = () => {
    startupReady = true
    clearTimeout(window.__paperStartupTimer)
  }
  window.__paperStartupTimer = setTimeout(async () => {
    const editor = document.getElementById('editor')
    const canRecover = () => !startupReady && editor && !editor.value.includes('\\documentclass')
    if (!canRecover()) return
    try {
      const match = location.pathname.match(/^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|$)/)
      const base = match ? `/p/${encodeURIComponent(match[1])}` : ''
      const manifestResponse = await fetch(`${base}/project/project.json`, { cache: 'no-store' })
      if (!canRecover()) return
      if (!manifestResponse.ok) throw new Error(`watchdog project.json ${manifestResponse.status}`)
      const manifest = await manifestResponse.json()
      if (!canRecover()) return
      const entrypoint = manifest.entrypoint || 'main.tex'
      const entry = (manifest.files || []).find(item => item?.path === entrypoint)
      const source = entry?.source || entrypoint
      const sourceUrl = `${base}/project/${source.split('/').map(encodeURIComponent).join('/')}`
      const sourceResponse = await fetch(sourceUrl, { cache: 'no-store' })
      if (!canRecover()) return
      if (!sourceResponse.ok) throw new Error(`watchdog manuscript ${sourceResponse.status}`)
      const manuscript = await sourceResponse.text()
      if (!canRecover()) return
      if (!manuscript.includes('\\documentclass')) throw new Error('watchdog received invalid manuscript')
      editor.value = manuscript
      editor.hidden = false
      document.getElementById('editor-panel').classList.add('legacy-editor')
      const titleMatch = manuscript.match(/\\title\{([^}]*)\}/)
      const title = titleMatch?.[1] || 'Recovered Paper'
      document.getElementById('project-title').value = title
      document.title = `${title} · Paper Workspace`
      document.getElementById('save-state').textContent = '서버 원고 복구됨 · 로컬 편집 모드'
      document.getElementById('render-state').textContent = '전체 기능을 복구하려면 새로고침'
      document.getElementById('collab-label').textContent = '로컬 편집'
      document.getElementById('collab-status').className = 'status-dot offline'
      window.__paperReportError('startup watchdog recovered manuscript')
      window.dispatchEvent(new CustomEvent('paper:startup-recovered'))
    } catch (error) {
      if (!canRecover()) return
      window.__paperReportError(`startup watchdog failed: ${error?.stack || error}`)
    }
  }, 5000)
})()
