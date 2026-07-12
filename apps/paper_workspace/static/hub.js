const list = document.getElementById('project-list')
const search = document.getElementById('project-search')
const sort = document.getElementById('project-sort')
const languagePicker = document.getElementById('hub-language')
const languageCode = document.getElementById('hub-language-code')
const avatar = document.getElementById('hub-collab-name')
const nameDialog = document.getElementById('hub-name-dialog')
const nameInput = document.getElementById('hub-name-input')
const i18n = window.PaperI18n
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const thumbnailPattern = /^\/projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/thumbnail\.(?:png|jpe?g|webp)$/i
const profileColors = ['#2457d6', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777']
let projects = []

i18n.register('en', {
  'language.label': 'Language',
  'hub.pageTitle': 'Paper Workspace · Projects',
  'hub.pageDescription': 'Write, collaborate, render PDFs, and manage research papers in one workspace.',
  'hub.shareImageAlt': 'Paper Workspace character writing at a laptop',
  'hub.home': 'Paper hub home',
  'hub.logoAlt': 'Paper hub',
  'hub.brandEyebrow': 'Research paper management',
  'hub.brandTitle': 'Paper Workspace',
  'hub.projectsEyebrow': 'Projects',
  'hub.chooseProject': 'Choose a paper to work on',
  'hub.projectSeparation': 'Edits, collaborator cursors, PDF rendering, and backups stay separate for each paper.',
  'hub.search': 'Search papers',
  'hub.sortLabel': 'Sort papers',
  'hub.sortRecent': 'Recently active',
  'hub.sortName': 'Name',
  'hub.sortComments': 'Papers with comments first',
  'hub.loadingProjects': 'Loading projects.',
  'hub.emptySearch': 'No papers match your search.',
  'hub.emptyProjects': 'No papers are available.',
  'hub.loadError': 'Could not load the project list.',
  'hub.loadErrorHint': 'Check projects/index.json on the server.',
  'hub.defaultDescription': 'Paper workspace',
  'hub.thumbnailAlt': 'First-page preview of {title}',
  'hub.edited': 'Edited in this browser',
  'hub.comment': '{count} comment',
  'hub.comments': '{count} comments',
  'hub.task': '{count} open task',
  'hub.tasks': '{count} open tasks',
  'profile.title': 'Set display name',
  'profile.description': 'This name and profile color are visible to collaborators.',
  'profile.color': 'Profile color',
  'profile.nameLabel': 'Display name',
  'profile.defaultName': 'Me',
  'profile.change': 'Change display name',
  'profile.settings': '{name} profile settings',
  'colors.blue': 'Blue',
  'colors.purple': 'Purple',
  'colors.cyan': 'Cyan',
  'colors.green': 'Green',
  'colors.orange': 'Orange',
  'colors.red': 'Red',
  'colors.pink': 'Pink',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.done': 'Done',
  'appearance.trigger': 'Appearance settings',
  'appearance.title': 'Appearance',
  'appearance.description': 'Applied to the hub and every paper in this browser.',
  'appearance.system': 'System',
  'appearance.systemDescription': 'Follow your device settings',
  'appearance.light': 'Light',
  'appearance.lightDescription': 'Always use a light workspace',
  'appearance.dark': 'Dark',
  'appearance.darkDescription': 'Always use a dark workspace'
})

i18n.register('ko', {
  'language.label': '언어',
  'hub.pageTitle': 'Paper Workspace · 논문 목록',
  'hub.pageDescription': '논문 편집, 협업, PDF 렌더링을 한곳에서 관리하는 연구실 작업공간입니다.',
  'hub.shareImageAlt': '책상에서 노트북으로 논문을 작성하는 Paper Workspace 캐릭터',
  'hub.home': '논문 허브 홈',
  'hub.logoAlt': '논문 허브',
  'hub.brandEyebrow': '연구실 논문 관리',
  'hub.brandTitle': '논문 작업공간',
  'hub.projectsEyebrow': '프로젝트',
  'hub.chooseProject': '작업할 논문을 선택하세요',
  'hub.projectSeparation': '논문마다 편집 내용, 협업 커서, PDF 렌더링, 백업이 분리됩니다.',
  'hub.search': '논문 검색',
  'hub.sortLabel': '논문 정렬',
  'hub.sortRecent': '최근 작업순',
  'hub.sortName': '이름순',
  'hub.sortComments': '댓글 있는 논문 우선',
  'hub.loadingProjects': '프로젝트 목록을 불러오는 중입니다.',
  'hub.emptySearch': '검색 조건에 맞는 논문이 없습니다.',
  'hub.emptyProjects': '표시할 수 있는 논문이 없습니다.',
  'hub.loadError': '프로젝트 목록을 불러오지 못했습니다.',
  'hub.loadErrorHint': '서버의 projects/index.json을 확인하세요.',
  'hub.defaultDescription': '논문 작업공간',
  'hub.thumbnailAlt': '{title} 첫 페이지 미리보기',
  'hub.edited': '편집 기록 있음',
  'hub.comment': '댓글 {count}',
  'hub.comments': '댓글 {count}',
  'hub.task': '할 일 {count}',
  'hub.tasks': '할 일 {count}',
  'profile.title': '표시 이름 설정',
  'profile.description': '공동 편집자에게 보이는 이름과 프로필 색상입니다.',
  'profile.color': '프로필 색상',
  'profile.nameLabel': '표시 이름',
  'profile.defaultName': '나',
  'profile.change': '표시 이름 변경',
  'profile.settings': '{name} 프로필 설정',
  'colors.blue': '파랑',
  'colors.purple': '보라',
  'colors.cyan': '청록',
  'colors.green': '초록',
  'colors.orange': '주황',
  'colors.red': '빨강',
  'colors.pink': '분홍',
  'common.cancel': '취소',
  'common.save': '저장',
  'common.done': '완료',
  'appearance.trigger': '화면 모드 설정',
  'appearance.title': '화면 모드',
  'appearance.description': '이 브라우저의 허브와 모든 논문에 함께 적용됩니다.',
  'appearance.system': '시스템',
  'appearance.systemDescription': '기기 설정에 맞춰 자동 전환',
  'appearance.light': '라이트',
  'appearance.lightDescription': '밝은 작업 화면을 항상 사용',
  'appearance.dark': '다크',
  'appearance.darkDescription': '어두운 작업 화면을 항상 사용'
})

const explicitLanguage = (() => {
  try { return i18n.normalize(new URLSearchParams(location.search).get('lang')) } catch (_) { return null }
})()
i18n.setLanguage(i18n.getLanguage(), { persist: Boolean(explicitLanguage), updateUrl: false })
sort.value = localStorage.getItem('paper-workspace:project-sort') || 'recent'

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char])
const collaboratorInitial = name => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join('') : words[0]?.slice(0, 2) || '?').toUpperCase()
}
const localizedField = (project, field) => {
  const language = i18n.getLanguage()
  const localized = project?.[`${field}_${language}`]
  if (typeof localized === 'string' && localized.trim()) return localized
  const value = project?.[field]
  if (value && typeof value === 'object') return value[language] || value.en || value.ko || ''
  return typeof value === 'string' ? value : ''
}
const searchableProjectText = project => [
  project.slug, project.display_name, project.display_name_en, project.display_name_ko,
  project.description, project.description_en, project.description_ko
].flatMap(value => value && typeof value === 'object' ? Object.values(value) : [value]).filter(Boolean).join(' ').toLowerCase()

function applyHubLanguage() {
  i18n.apply(document)
  languagePicker.value = i18n.getLanguage()
  const currentLanguage = i18n.getLanguage()
  languageCode.textContent = currentLanguage === 'ko' ? '한국어' : 'English'
  languageCode.dataset.short = currentLanguage.toUpperCase()
  document.title = i18n.t('hub.pageTitle')
  document.querySelector('meta[name="description"]')?.setAttribute('content', i18n.t('hub.pageDescription'))
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', i18n.t('hub.pageTitle'))
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', i18n.t('hub.pageDescription'))
  document.querySelector('meta[property="og:locale"]')?.setAttribute('content', i18n.getLanguage() === 'ko' ? 'ko_KR' : 'en_US')
  document.querySelector('meta[property="og:image:alt"]')?.setAttribute('content', i18n.t('hub.shareImageAlt'))
  document.querySelectorAll('[data-i18n-alt]').forEach(element => element.setAttribute('alt', i18n.t(element.dataset.i18nAlt)))
  nameInput.setAttribute('aria-label', i18n.t('profile.nameLabel'))
  document.querySelectorAll('input[name="hub-profile-color"]').forEach(input => {
    const label = input.closest('label')
    input.setAttribute('aria-label', label?.title || i18n.t('profile.color'))
  })
  if (!avatar.hidden) paintAvatar()
}

function currentProfile() {
  const userSet = localStorage.getItem('collab-name-user-set') === '1'
  let storedName = localStorage.getItem('collab-name')
  if (!userSet && (storedName === 'daehwa' || storedName === '나' || storedName === 'Me')) storedName = ''
  const name = (storedName || i18n.t('profile.defaultName')).trim() || i18n.t('profile.defaultName')
  const storedColor = localStorage.getItem('collab-color')
  return { name, color: profileColors.includes(storedColor) ? storedColor : '#2457d6' }
}

function paintAvatar() {
  const profile = currentProfile()
  avatar.textContent = collaboratorInitial(profile.name)
  avatar.style.background = profile.color
  avatar.title = `${profile.name} · ${i18n.t('profile.change')}`
  avatar.setAttribute('aria-label', i18n.t('profile.settings', { name: profile.name }))
}

function localProjectState(slug) {
  try {
    const draft = JSON.parse(localStorage.getItem(`paper-workspace:${slug}`) || 'null')
    const comments = Array.isArray(draft?.comments) ? draft.comments.length : 0
    const tasks = Array.isArray(draft?.tasks) ? draft.tasks.filter(task => !task.done).length : 0
    const edited = Boolean(draft?.files && Object.keys(draft.files).length)
    const lastActive = Number(localStorage.getItem(`paper-workspace:last-active:${slug}`)) || 0
    return { comments, tasks, edited, lastActive }
  } catch (_) {
    return { comments: 0, tasks: 0, edited: false, lastActive: 0 }
  }
}

function sortedProjects(items) {
  const decorated = items.map((project, index) => ({ project, index, local: localProjectState(project.slug) }))
  if (sort.value === 'name') {
    decorated.sort((left, right) => localizedField(left.project, 'display_name').localeCompare(
      localizedField(right.project, 'display_name'), i18n.getLanguage() === 'ko' ? 'ko' : 'en'
    ))
  } else if (sort.value === 'comments') {
    decorated.sort((left, right) => right.local.comments - left.local.comments || right.local.lastActive - left.local.lastActive || left.index - right.index)
  } else {
    decorated.sort((left, right) => right.local.lastActive - left.local.lastActive || left.index - right.index)
  }
  return decorated
}

function renderSession(authenticated) {
  avatar.hidden = !authenticated
  if (authenticated) paintAvatar()
}

async function loadSession() {
  try {
    const response = await fetch('/_auth/verify', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    renderSession(response.ok)
  } catch (_) {
    renderSession(false)
  }
}

avatar.addEventListener('click', () => {
  const profile = currentProfile()
  nameInput.value = profile.name
  document.querySelector(`input[name="hub-profile-color"][value="${profile.color}"]`).checked = true
  nameDialog.showModal()
  nameInput.focus()
})
nameInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    nameDialog.close('confirm')
  }
})
nameDialog.addEventListener('close', () => {
  if (nameDialog.returnValue !== 'confirm') return
  const name = nameInput.value.trim()
  const color = document.querySelector('input[name="hub-profile-color"]:checked')?.value
  if (!name) return
  localStorage.setItem('collab-name', name.slice(0, 32))
  localStorage.setItem('collab-name-user-set','1')
  if (profileColors.includes(color)) localStorage.setItem('collab-color', color)
  paintAvatar()
})
window.addEventListener('storage', event => {
  if (!avatar.hidden && (event.key === 'collab-name' || event.key === 'collab-color')) paintAvatar()
})
window.addEventListener('focus', () => {
  if (!avatar.hidden) paintAvatar()
})

function renderProjects() {
  const query = search.value.trim().toLowerCase()
  const visible = sortedProjects(projects.filter(project => searchableProjectText(project).includes(query)))
  list.setAttribute('aria-busy', 'false')
  if (!visible.length) {
    list.innerHTML = `<div class="empty-card">${escapeHtml(i18n.t(projects.length ? 'hub.emptySearch' : 'hub.emptyProjects'))}</div>`
    return
  }
  list.innerHTML = visible.map(({ project, local }) => {
    if (!slugPattern.test(project.slug || '')) return ''
    const rawTitle = localizedField(project, 'display_name') || project.slug
    const title = escapeHtml(rawTitle)
    const description = escapeHtml(localizedField(project, 'description') || i18n.t('hub.defaultDescription'))
    const updated = escapeHtml(localizedField(project, 'updated_at'))
    const thumbnail = thumbnailPattern.test(project.thumbnail || '') ? project.thumbnail : ''
    const visual = thumbnail
      ? `<div class="project-thumbnail-wrap"><img class="project-thumbnail" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(i18n.t('hub.thumbnailAlt', { title: rawTitle }))}" loading="lazy" /></div>`
      : '<span class="project-icon">T</span>'
    const meta = [
      updated,
      local.edited ? i18n.t('hub.edited') : '',
      local.comments ? i18n.t(local.comments === 1 ? 'hub.comment' : 'hub.comments', { count: local.comments }) : '',
      local.tasks ? i18n.t(local.tasks === 1 ? 'hub.task' : 'hub.tasks', { count: local.tasks }) : ''
    ].filter(Boolean)
    return `<a class="project-card" href="/p/${encodeURIComponent(project.slug)}"><div class="project-card-top">${visual}<svg class="project-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></div><div class="project-card-copy"><h3>${title}</h3><p>${description}</p></div>${meta.length ? `<div class="project-meta">${meta.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}</a>`
  }).join('') || `<div class="empty-card">${escapeHtml(i18n.t('hub.emptyProjects'))}</div>`
}

async function loadProjects() {
  try {
    const response = await fetch('/projects/index.json', { cache: 'no-store' })
    if (!response.ok) throw new Error(i18n.t('hub.loadError'))
    const payload = await response.json()
    projects = Array.isArray(payload) ? payload : (Array.isArray(payload.projects) ? payload.projects : [])
    renderProjects()
  } catch (error) {
    list.setAttribute('aria-busy', 'false')
    list.innerHTML = `<div class="empty-card">${escapeHtml(error.message || i18n.t('hub.loadError'))}<br><small>${escapeHtml(i18n.t('hub.loadErrorHint'))}</small></div>`
  }
}

languagePicker.addEventListener('change', () => i18n.setLanguage(languagePicker.value, { persist: true, updateUrl: true }))
i18n.onChange(() => {
  applyHubLanguage()
  renderProjects()
})
search.addEventListener('input', renderProjects)
sort.addEventListener('change', () => {
  localStorage.setItem('paper-workspace:project-sort', sort.value)
  renderProjects()
})

applyHubLanguage()
loadProjects()
loadSession()
