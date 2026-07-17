(() => {
  'use strict'

  const page = document.currentScript?.dataset.paperPage || 'hub'
  try {
    const queryLanguage = new URLSearchParams(location.search).get('lang')
    const savedLanguage = localStorage.getItem('paper-workspace-language')
    const browserLanguage = (navigator.languages || [navigator.language])
      .map(value => String(value || '').toLowerCase().split('-')[0])
      .find(value => value === 'en' || value === 'ko')
    const language = ['en', 'ko'].includes(queryLanguage)
      ? queryLanguage
      : ['en', 'ko'].includes(savedLanguage) ? savedLanguage : browserLanguage || 'en'
    document.documentElement.lang = language
    document.documentElement.dataset.language = language
    const theme = localStorage.getItem('paper-workspace-theme') || 'system'
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme:dark)').matches)
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.colorScheme = dark ? 'dark' : 'light'
  } catch {
    document.documentElement.lang = 'en'
  }

  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args)
    let redirectedToLogin = false
    try {
      redirectedToLogin = response.status === 401 || (response.redirected && new URL(response.url).pathname.startsWith('/_auth/login'))
    } catch {}
    if (redirectedToLogin && !location.pathname.startsWith('/_auth/')) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`
      location.assign(`/_auth/login?rd=${encodeURIComponent(returnTo)}`)
      throw new DOMException('Authentication required', 'AbortError')
    }
    return response
  }

  if (page !== 'workspace') return

  const redactError = value => String(value || 'unknown error')
    .replace(/\b(?:Bearer\s+)?(?:sk-|github_pat_|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_+./=-]{8,}/gi, '[credential]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/https?:\/\/[^\s)]+/gi, '[url]')
    .replace(/(?:\/home|\/Users|[A-Z]:\\Users)[^\s:)]+/g, '[local-path]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240)

  const errorKind = message => {
    const value = String(message || '').toLowerCase()
    if (value.includes('startup watchdog')) return 'startup'
    if (value.includes('collaboration')) return 'collaboration'
    if (value.includes('promise')) return 'promise'
    return 'runtime'
  }
  const reportPath = () => {
    const match = location.pathname.match(/^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|$)/)
    return match ? `/p/${match[1]}` : '/'
  }

  window.__paperReportError = message => {
    try {
      const redacted = redactError(message)
      fetch('/__client_error', {
        body: JSON.stringify({ kind: errorKind(redacted), message: redacted, path: reportPath() }),
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        method: 'POST'
      }).catch(() => {})
    } catch {}
  }
  window.addEventListener('error', event => window.__paperReportError(event.error?.stack || event.message))
  window.addEventListener('unhandledrejection', event => window.__paperReportError(event.reason?.stack || event.reason))
  window.__paperMarkStartupReady = () => clearTimeout(window.__paperStartupTimer)
  window.__paperStartupTimer = setTimeout(async () => {
    const editor = document.getElementById('editor')
    if (editor?.value.includes('\\documentclass')) return
    try {
      const match = location.pathname.match(/^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|$)/)
      const base = match ? `/p/${encodeURIComponent(match[1])}` : ''
      const manifestResponse = await fetch(`${base}/project/project.json`, { cache: 'no-store' })
      if (!manifestResponse.ok) throw new Error(`watchdog project.json ${manifestResponse.status}`)
      const manifest = await manifestResponse.json()
      const entrypoint = manifest.entrypoint || 'main.tex'
      const entry = (manifest.files || []).find(item => item?.path === entrypoint)
      const source = entry?.source || entrypoint
      const sourceUrl = `${base}/project/${source.split('/').map(encodeURIComponent).join('/')}`
      const sourceResponse = await fetch(sourceUrl, { cache: 'no-store' })
      if (!sourceResponse.ok) throw new Error(`watchdog manuscript ${sourceResponse.status}`)
      const manuscript = await sourceResponse.text()
      if (!manuscript.includes('\\documentclass')) throw new Error('watchdog received invalid manuscript')
      if (editor.value.includes('\\documentclass')) return
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
      window.__paperReportError(`startup watchdog failed: ${error?.stack || error}`)
    }
  }, 5000)
})()
