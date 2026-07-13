(() => {
  const supported = new Set(['en', 'ko'])
  const dictionaries = { en: {}, ko: {} }
  const listeners = new Set()
  const storageKey = 'paper-workspace-language'

  function normalize(value) {
    const language = String(value || '').trim().toLowerCase().split('-')[0]
    return supported.has(language) ? language : null
  }

  function queryLanguage() {
    try { return normalize(new URLSearchParams(location.search).get('lang')) } catch (_) { return null }
  }

  function storedLanguage() {
    try { return normalize(localStorage.getItem(storageKey)) } catch (_) { return null }
  }

  function browserLanguage() {
    const candidates = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language]
    for (const candidate of candidates) {
      const language = normalize(candidate)
      if (language) return language
    }
    return null
  }

  let language = queryLanguage() || storedLanguage() || browserLanguage() || 'en'

  function interpolate(value, variables = {}) {
    return String(value).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match
    ))
  }

  function register(locale, messages) {
    const normalized = normalize(locale)
    if (!normalized || !messages || typeof messages !== 'object') return
    Object.assign(dictionaries[normalized], messages)
  }

  function t(key, variables = {}) {
    const value = dictionaries[language][key] ?? dictionaries.en[key] ?? key
    return interpolate(value, variables)
  }

  function variablesFor(element) {
    try { return JSON.parse(element.dataset.i18nVariables || '{}') } catch (_) { return {} }
  }

  function setText(element, key, variables = {}) {
    if (!element) return
    element.dataset.i18n = key
    if (Object.keys(variables).length) element.dataset.i18nVariables = JSON.stringify(variables)
    else delete element.dataset.i18nVariables
    element.textContent = t(key, variables)
  }

  function apply(root = document) {
    root.querySelectorAll?.('[data-i18n]').forEach(element => {
      element.textContent = t(element.dataset.i18n, variablesFor(element))
    })
    root.querySelectorAll?.('[data-i18n-placeholder]').forEach(element => {
      element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder))
    })
    root.querySelectorAll?.('[data-i18n-label]').forEach(element => {
      element.setAttribute('aria-label', t(element.dataset.i18nLabel))
    })
    root.querySelectorAll?.('[data-i18n-title]').forEach(element => {
      element.setAttribute('title', t(element.dataset.i18nTitle))
    })
  }

  function setLanguage(next, { persist = true, updateUrl = false } = {}) {
    const normalized = normalize(next)
    if (!normalized) return language
    language = normalized
    document.documentElement.lang = language
    document.documentElement.dataset.language = language
    if (persist) {
      try { localStorage.setItem(storageKey, language) } catch (_) {}
      document.cookie = `paper_language=${language}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
    }
    if (updateUrl) {
      const url = new URL(location.href)
      url.searchParams.set('lang', language)
      history.replaceState(history.state, '', url)
    }
    apply(document)
    listeners.forEach(listener => listener(language))
    window.dispatchEvent(new CustomEvent('paper-language-change', { detail: { language } }))
    return language
  }

  function onChange(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function formatDate(value, options = { dateStyle: 'short', timeStyle: 'short' }) {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', options).format(date)
  }

  document.documentElement.lang = language
  document.documentElement.dataset.language = language
  window.PaperI18n = Object.freeze({
    apply, formatDate, getLanguage: () => language, normalize, onChange, register,
    setLanguage, setText, storageKey, supported: [...supported], t
  })
})()
