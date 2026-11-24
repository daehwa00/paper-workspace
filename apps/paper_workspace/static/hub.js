const list = document.getElementById('project-list')
const sort = document.getElementById('project-sort')
const languagePicker = document.getElementById('hub-language')
const languageCode = document.getElementById('hub-language-code')
const avatar = document.getElementById('hub-collab-name')
const nameDialog = document.getElementById('hub-name-dialog')
const nameInput = document.getElementById('hub-name-input')
const i18n = window.PaperI18n
const preferences = window.PaperPreferenceStorage
try {
  const layout = JSON.parse(preferences?.get('paper-workspace-layout') || '{}')
  const width = Number(layout.sidebarWidth)
  if (Number.isFinite(width) && width > 0) document.body.style.setProperty('--hub-sidebar-width', `${Math.min(320, Math.max(180, width))}px`)
} catch { /* A missing or malformed preference uses the default width. */ }
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const thumbnailPattern = /^\/projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/thumbnail\.(?:png|jpe?g|webp)$/i
const profileColors = ['#2457d6', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777']
let projects = []
const projectMetadata = new Map()
let metadataReady = false
let metadataEditor = null
let subtitleEditor = null
let metadataToastTimer
let metadataToast
let projectActivity = new Map()
let activityLoadState = 'pending'
document.addEventListener('click', event => {
  const link = event.target.closest?.('.project-open')
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const match = new URL(link.href, location.href).pathname.match(/^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/)
  const title = link.querySelector('h3')?.textContent || link.querySelector('span')?.textContent
  if (match && title) try { sessionStorage.setItem(`paper-project-title:${match[1]}`, title.trim().slice(0,160)) } catch {}
})

i18n.register('en', {
  'language.label': 'Language',
  'hub.pageTitle': 'Paper Workspace · Projects',
  'hub.pageDescription': 'Write, collaborate, render PDFs, and manage research papers in one workspace.',
  'hub.shareImageAlt': 'Paper Workspace logo',
  'hub.home': 'Paper hub home',
  'hub.logoAlt': 'Paper hub',
  'hub.brandEyebrow': 'Research paper management',
  'hub.brandTitle': 'Paper Workspace',
  'hub.projectsEyebrow': 'Projects',
  'hub.chooseProject': 'All papers',
  'hub.calendar': 'Calendar',
  'hub.calendarToday': 'Go to today',
  'hub.calendarPrevious': 'Previous month',
  'hub.calendarNext': 'Next month',
  'hub.calendarExpand': 'Expand calendar',
  'hub.calendarOverview': 'Conference calendar',
  'hub.calendarClose': 'Close calendar',
  'hub.calendarTodayShort': 'Today',
  'hub.upcomingDeadlines': 'Upcoming deadlines',
  'hub.noDeadlines': 'No upcoming confirmed deadlines',
  'hub.noDayDeadlines': 'No deadlines scheduled for this day.',
  'hub.conferenceDetails': 'Conference details',
  'hub.conferenceLocation': 'Location',
  'hub.conferenceDates': 'Dates (local)',
  'hub.conferenceDeadlines': 'Deadlines',
  'hub.conferenceWebsite': 'Website ↗',
  'hub.officialDeadline': 'Official dates ↗',
  'hub.closeDeadline': 'Close deadline details',
  'hub.deadlineToday': 'Today',
  'hub.deadlineTomorrow': 'Tomorrow',
  'hub.commitmentNote': 'Commit reviewed ARR papers; not a new paper submission.',
  'hub.arrNote': 'Full paper submission to ARR for ACL consideration.',
  'hub.projectView': 'Project view',
  'hub.columnProject': 'Project',
  'hub.columnActivity': 'Last activity',
  'hub.columnProperties': 'Properties',
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
  'hub.comment': '{count} comment',
  'hub.comments': '{count} comments',
  'hub.task': '{count} open task',
  'hub.tasks': '{count} open tasks',
  'hub.lastEdited': '{actor} · {time}',
  'hub.localActivity': 'Local browser activity · {actor} · {time}',
  'hub.noActivity': 'No edit history yet',
  'hub.activityUnavailable': 'Activity details are temporarily unavailable',
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
  'hub.shareImageAlt': 'Paper Workspace 로고',
  'hub.home': '논문 허브 홈',
  'hub.logoAlt': '논문 허브',
  'hub.brandEyebrow': '연구실 논문 관리',
  'hub.brandTitle': 'Paper Workspace',
  'hub.projectsEyebrow': '프로젝트',
  'hub.chooseProject': '전체 논문',
  'hub.calendar': '캘린더',
  'hub.calendarToday': '오늘로 이동',
  'hub.calendarPrevious': '지난달',
  'hub.calendarNext': '다음달',
  'hub.calendarExpand': '캘린더 크게 보기',
  'hub.calendarOverview': '학회 캘린더',
  'hub.calendarClose': '캘린더 닫기',
  'hub.calendarTodayShort': '오늘',
  'hub.upcomingDeadlines': 'Upcoming deadlines',
  'hub.noDeadlines': '예정된 확정 마감이 없습니다',
  'hub.noDayDeadlines': '등록된 마감이 없는 날입니다.',
  'hub.conferenceDetails': '학회 상세 정보',
  'hub.conferenceLocation': '개최 장소',
  'hub.conferenceDates': '개최 일정 (현지)',
  'hub.conferenceDeadlines': '제출 마감',
  'hub.conferenceWebsite': '공식 웹사이트 ↗',
  'hub.officialDeadline': '공식 일정 ↗',
  'hub.closeDeadline': '마감 상세 닫기',
  'hub.deadlineToday': '오늘 마감',
  'hub.deadlineTomorrow': '내일 마감',
  'hub.commitmentNote': 'ARR 심사를 마친 논문의 제출 확정입니다. 신규 논문 제출과 다릅니다.',
  'hub.arrNote': 'ACL 심사를 위한 ARR 논문 제출 마감입니다.',
  'hub.projectView': '프로젝트 보기',
  'hub.columnProject': '프로젝트',
  'hub.columnActivity': '최근 활동',
  'hub.columnProperties': '속성',
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
  'hub.comment': '댓글 {count}',
  'hub.comments': '댓글 {count}',
  'hub.task': '할 일 {count}',
  'hub.tasks': '할 일 {count}',
  'hub.lastEdited': '{actor} · {time}',
  'hub.localActivity': '이 브라우저의 최근 작업 · {actor} · {time}',
  'hub.noActivity': '아직 수정 기록 없음',
  'hub.activityUnavailable': '최근 작업 정보를 잠시 불러올 수 없습니다',
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
sort.value = preferences.get('paper-workspace:project-sort') || 'recent'

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


function applyHubLanguage() {
  i18n.apply(document)
  if (window.PaperAccess?.user) {
    document.querySelector('[data-i18n="hub.brandEyebrow"]').textContent = '/' + window.PaperAccess.user
    document.getElementById('account-logout').hidden = false
    document.getElementById('account-logout-button').textContent = i18n.getLanguage() === 'ko' ? '로그아웃' : 'Sign out'
  }
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
  const userSet = preferences.get('collab-name-user-set') === '1'
  let storedName = preferences.get('collab-name')
  if (!userSet && (storedName === 'secondary_host' || storedName === '나' || storedName === 'Me')) storedName = ''
  const name = (storedName || i18n.t('profile.defaultName')).trim() || i18n.t('profile.defaultName')
  const storedColor = preferences.get('collab-color')
  return { name, color: profileColors.includes(storedColor) ? storedColor : '#2457d6' }
}

function paintAvatar() {
  const profile = currentProfile()
  avatar.textContent = collaboratorInitial(profile.name)
  avatar.style.background = profile.color
  avatar.style.color = window.PaperUI.contrastTextFor(profile.color)
  avatar.title = `${profile.name} · ${i18n.t('profile.change')}`
  avatar.setAttribute('aria-label', i18n.t('profile.settings', { name: profile.name }))
}

function localProjectState(project) {
  const slug = project.slug
  let draft = null, browserActive = 0
  try {
    browserActive = Number(preferences.get(`paper-workspace:last-active:${slug}`)) || 0
    draft = JSON.parse(preferences.get(`paper-workspace:${slug}`) || 'null')
  } catch (_) {}
  const count = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback
  const comments = count(draft?.commentCount, Array.isArray(draft?.comments) ? draft.comments.length : 0)
  const tasks = count(draft?.openTaskCount, Array.isArray(draft?.tasks) ? draft.tasks.filter(task => task && !task.done).length : 0)
  const activityId = slugPattern.test(project.activity_id || '') ? project.activity_id : slug
  const activity = projectActivity.get(activityId)
  const serverActive = Date.parse(activity?.modified_at || '') || 0
  const modifiedAt = serverActive || browserActive
  const actor = activity?.actor || (browserActive ? currentProfile().name : '')
  return { comments, tasks, modifiedAt, actor, hasServerActivity: Boolean(activity), hasLocalActivity: browserActive > 0 }
}

function formatActivityTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date(), locale = i18n.getLanguage() === 'ko' ? 'ko-KR' : 'en-US'
  const key = calendarKstKey(date), today = calendarKstKey(now)
  const days = Math.round((Date.parse(today)-Date.parse(key))/86400000)
  const elapsed = now-date
  if (elapsed >= 0 && days === 0) {
    if (elapsed < 60000) return locale === 'ko-KR' ? '방금' : 'Just now'
    const unit = elapsed < 3600000 ? 'minute' : 'hour'
    return new Intl.RelativeTimeFormat(locale,{numeric:'always'}).format(-Math.floor(elapsed/(unit==='minute'?60000:3600000)),unit)
  }
  if (elapsed >= 0 && days >= 1 && days <= 7) {
    return new Intl.RelativeTimeFormat(locale,{numeric:days===1?'auto':'always'}).format(-days,'day')
  }
  if (key.slice(0,4)!==today.slice(0,4) && locale==='ko-KR') return key.replaceAll('-','.')
  const options = {timeZone:'Asia/Seoul',month:'short',day:'numeric'}
  if (key.slice(0,4)!==today.slice(0,4)) options.year = 'numeric'
  return new Intl.DateTimeFormat(locale,options).format(date)
}

function formatActivityTimestamp(value) {
  return new Intl.DateTimeFormat(i18n.getLanguage()==='ko'?'ko-KR':'en-US',{
    timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).format(new Date(value))+' KST'
}

setInterval(()=>{
  if (!document.hidden) list.querySelectorAll('time.project-activity-time').forEach(time=>{
    time.textContent = formatActivityTime(Date.parse(time.dateTime))
  })
},60000)

function sortedProjects(items) {
  const decorated = items.map((project, index) => ({ project, index, local: localProjectState(project) }))
  if (sort.value === 'name') {
    decorated.sort((left, right) => localizedField(left.project, 'display_name').localeCompare(
      localizedField(right.project, 'display_name'), i18n.getLanguage() === 'ko' ? 'ko' : 'en'
    ))
  } else if (sort.value === 'comments') {
    decorated.sort((left, right) => right.local.comments - left.local.comments || right.local.modifiedAt - left.local.modifiedAt || left.index - right.index)
  } else {
    decorated.sort((left, right) => right.local.modifiedAt - left.local.modifiedAt || left.index - right.index)
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
  preferences.set('collab-name', name.slice(0, 32))
  preferences.set('collab-name-user-set','1')
  if (profileColors.includes(color)) preferences.set('collab-color', color)
  paintAvatar()
})
window.addEventListener('storage', event => {
  if (!avatar.hidden && (event.key === 'collab-name' || event.key === 'collab-color')) paintAvatar()
})
window.addEventListener('focus', () => {
  if (!avatar.hidden) paintAvatar()
})

// Verified official main-track dates, ICORE 2026 A*/A only. See the
// conference-deadlines-2026-2027.md source ledger before adding/changing dates.
// Keep the original AoE day; derive KST instead of maintaining two date copies.
const conferenceDetails = {
  ICAPS:{home:'https://icaps27.icaps-conference.org/',location:'Columbia, SC, USA',dates:'2027.06.27 – 07.02',en:'Automated planning · Scheduling · Decision making',ko:'자동 계획 · 스케줄링 · 의사결정'},
  NAACL:{home:'https://2027.naacl.org/',location:'San Francisco, CA, USA',dates:'2027.06.01 – 06.05',en:'Natural language processing · Computational linguistics',ko:'자연어 처리 · 전산언어학'},
  ACL:{home:'https://2027.aclweb.org/',location:'Kyoto, Japan',dates:'2027.08.17 – 08.22',en:'Natural language processing · Computational linguistics',ko:'자연어 처리 · 전산언어학'},
  IJCAI:{home:'https://2027.ijcai.org/',location:'Kyoto, Japan',dates:'2027.08.07 – 08.13',en:'Artificial intelligence · Theory and applications',ko:'인공지능 전반 · 이론과 응용'},
  ICML:{home:'https://icml.cc/Conferences/2027',location:'Riocentro · Rio de Janeiro, Brazil',dates:'2027.07.31 – 08.06',en:'Machine learning · Statistics · Applications',ko:'머신러닝 · 통계 · 응용'},
  SIGIR:{home:'https://sigir2027.org/',location:'Signia by Hilton · San Jose, CA, USA',dates:'2027.07.19 – 07.24',en:'Information retrieval · Search · Ranking · Recommendation',ko:'정보 검색 · 검색 · 랭킹 · 추천'},
  COLT:{home:'https://learningtheory.org/colt2027/',location:'Tokyo, Japan',dates:'2027.06.28 – 07.02',en:'Learning theory · Theoretical machine learning',ko:'학습 이론 · 이론적 머신러닝'}
}
const {renderCalendar, calendarKstKey} = window.PaperHubCalendar({i18n, escapeHtml})

const boundThumbnailFallbacks = new WeakSet()
function updateProjectRows(markup) {
  // Parse off-screen so new img elements do not start redundant requests.
  const template = document.createElement('template')
  template.innerHTML = markup
  const existing = new Map([...list.children].filter(row=>row.dataset.projectSlug).map(row=>[row.dataset.projectSlug,row]))
  const retained = new Set()
  let cursor = list.firstElementChild
  for (const next of [...template.content.children]) {
    const row = existing.get(next.dataset.projectSlug) || next
    if (row !== next) {
      const previousVisual = row.querySelector('.project-card-top'), nextVisual = next.querySelector('.project-card-top')
      if (previousVisual.dataset.thumbnail !== nextVisual.dataset.thumbnail) previousVisual.replaceWith(nextVisual)
      else {
        const image = previousVisual.querySelector('img'), nextImage = nextVisual.querySelector('img')
        if (image) {
          if (image.alt !== nextImage.alt) image.alt = nextImage.alt
          image.dataset.projectFallback = nextImage.dataset.projectFallback
        } else {
          const fallback = previousVisual.querySelector('.project-icon')
          if (fallback) fallback.textContent = nextImage.dataset.projectFallback
        }
      }
      for (const selector of ['.project-card-copy','.project-activity','.project-meta']) {
        const current = row.querySelector(selector), replacement = next.querySelector(selector)
        if (current.innerHTML !== replacement.innerHTML) current.replaceChildren(...replacement.childNodes)
        if (current.getAttribute('title') !== replacement.getAttribute('title')) {
          if (replacement.hasAttribute('title')) current.setAttribute('title',replacement.getAttribute('title'))
          else current.removeAttribute('title')
        }
      }
    }
    retained.add(row)
    if (row === cursor) cursor = cursor.nextElementSibling
    else list.insertBefore(row,cursor)
  }
  for (const row of [...list.children]) if (!retained.has(row)) row.remove()
}
function renderProjects() {
  // Background refreshes must not replace a subtitle while it is being typed.
  if (subtitleEditor) return
  list.dataset.activityStatus = activityLoadState
  const visible = sortedProjects(projects)
  list.setAttribute('aria-busy', 'false')
  document.getElementById('hub-location-count').textContent = String(projects.length)
  if (!visible.length) {
    list.innerHTML = `<div class="empty-card">${escapeHtml(i18n.t('hub.emptyProjects'))}</div>`
    return
  }
  const markup = visible.map(({ project, local }) => {
    if (!slugPattern.test(project.slug || '')) return ''
    const rawTitle = localizedField(project, 'display_name') || project.slug
    const title = escapeHtml(rawTitle)
    const description = escapeHtml(projectSubtitle(project))
    const editable = metadataReady && window.PaperAccess?.projects?.[project.slug] !== 'viewer'
    const subtitle = editable ? `<button type="button" class="project-subtitle-edit${description?'':' is-empty'}" data-project="${project.slug}" data-metadata-field="description" aria-label="${escapeHtml(hubText('Edit subtitle','부제목 수정'))}" title="${description}">${description || escapeHtml(hubText('Add subtitle','부제목 추가'))}</button>` : `<p title="${description}">${description}</p>`
    const updated = escapeHtml(projectVenue(project))
    const venue = editable ? `<button type="button" class="project-venue ${updated?'':'is-empty'}" data-project="${project.slug}" data-metadata-field="venue" aria-label="${escapeHtml(hubText('Edit target venue','목표 학회 수정'))}" title="${updated}">${updated || escapeHtml(hubText('Add venue','학회 추가'))}</button>` : (updated ? `<span>${updated}</span>` : '')
    const href = `/p/${encodeURIComponent(project.slug)}`
    const pageCount = Number.isSafeInteger(project.page_count) && project.page_count > 0 && project.page_count <= 1000
      ? `${project.page_count}p`
      : ''
    const thumbnail = thumbnailPattern.test(project.thumbnail || '')
      ? project.thumbnail
      : `/projects/${encodeURIComponent(project.slug)}/thumbnail.png`
    const fallback = rawTitle.trim().charAt(0).toUpperCase() || 'T'
    const visual = `<div class="project-thumbnail-wrap"><img class="project-thumbnail" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(i18n.t('hub.thumbnailAlt', { title: rawTitle }))}" loading="lazy" data-project-fallback="${escapeHtml(fallback)}" /></div>`
    const badges = [
      updated,
      local.comments ? i18n.t(local.comments === 1 ? 'hub.comment' : 'hub.comments', { count: local.comments }) : '',
      local.tasks ? i18n.t(local.tasks === 1 ? 'hub.task' : 'hub.tasks', { count: local.tasks }) : ''
    ].filter(Boolean)
    const meta = `${venue}${pageCount ? `<a href="${href}" class="project-page-link" tabindex="-1" aria-hidden="true"><small id="project-page-count-${project.slug}" class="project-page-count">${pageCount}</small></a>` : ''}${badges.slice(updated ? 1 : 0).map(item => `<span>${escapeHtml(item)}</span>`).join('')}`
    const activityTime = local.modifiedAt ? formatActivityTime(local.modifiedAt) : ''
    const activityTimestamp = activityTime ? formatActivityTimestamp(local.modifiedAt) : ''
    const activityLabel = local.actor && activityTime
      ? i18n.t(activityLoadState === 'unavailable' && !local.hasServerActivity ? 'hub.localActivity' : 'hub.lastEdited', { actor: local.actor, time: activityTimestamp })
      : activityLoadState === 'unavailable' ? i18n.t('hub.activityUnavailable') : i18n.t('hub.noActivity')
    const activityContent=local.actor&&activityTime?`<span class="project-actor" title="${escapeHtml(local.actor)}">${escapeHtml(local.actor)}</span> <time class="project-activity-time" datetime="${new Date(local.modifiedAt).toISOString()}" title="${escapeHtml(activityTimestamp)}" aria-label="${escapeHtml(activityTimestamp)}">${escapeHtml(activityTime)}</time>`:`<span class="project-activity-empty">${escapeHtml(activityLabel)}</span>`
    return `<div class="project-list-entry" data-project-slug="${project.slug}" role="listitem"><div class="project-card"><div class="project-card-top" data-thumbnail="${escapeHtml(thumbnail)}">${visual}<svg class="project-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></div><div class="project-card-copy"><a class="project-open" href="${href}"${pageCount ? ` aria-describedby="project-page-count-${project.slug}"` : ''}><h3 title="${title}">${title}</h3></a>${subtitle}</div><div class="project-activity" title="${escapeHtml(activityLabel)}">${activityContent}</div><div class="project-meta">${meta}</div></div></div>`
  }).join('') || `<div class="empty-card">${escapeHtml(i18n.t('hub.emptyProjects'))}</div>`
  updateProjectRows(markup)
  list.querySelectorAll('img[data-project-fallback]').forEach(image => {
    if (boundThumbnailFallbacks.has(image)) return
    boundThumbnailFallbacks.add(image)
    image.addEventListener('error', () => {
      const fallback = document.createElement('span')
      fallback.className = 'project-icon'
      fallback.textContent = image.dataset.projectFallback || 'T'
      image.closest('.project-thumbnail-wrap')?.replaceWith(fallback)
    }, { once: true })
  })
}

let projectLoadPending=false
async function refreshPageCounts(items) {
  let next=0
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
    while(next<items.length){
      const project=items[next++]
      const id=slugPattern.test(project.activity_id||'')?project.activity_id:project.slug
      if(!slugPattern.test(id||''))continue
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000)
      try{
        const response=await fetch(`/api/backups/projects/${encodeURIComponent(id)}/assets/__paper_workspace/main-page-count.json`,{cache:'no-store',signal:controller.signal})
        if(!response.ok)continue
        const metadata=await response.json()
        if(Number.isSafeInteger(metadata.page_count)&&metadata.page_count>0&&metadata.page_count<=1000)project.page_count=metadata.page_count
      }catch{}finally{clearTimeout(timer)}
    }
  }))
}
async function loadProjects() {
  if(projectLoadPending)return
  projectLoadPending=true
  try {
    const activity = fetch('/api/backups/activity', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('activity unavailable')
        const payload = await response.json()
        const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.projects) ? payload.projects : null
        if (!entries) throw new Error('activity payload unavailable')
        metadataReady = Array.isArray(payload?.metadata)
        if (metadataReady) for (const record of payload.metadata) rememberMetadata(record)
        return entries
      })
      .then(entries => {
        projectActivity = new Map(entries.filter(item => slugPattern.test(item?.project_id || '')).map(item => [item.project_id, item]))
        activityLoadState = 'available'
      })
      .catch(() => {
        projectActivity = new Map()
        activityLoadState = 'unavailable'
        metadataReady = false
      })
    const [response] = await Promise.all([
      fetch('/projects/index.json', { cache: 'no-store' }),
      activity
    ])
    if (!response.ok) throw new Error(i18n.t('hub.loadError'))
    const payload = await response.json()
    const entries = Array.isArray(payload) ? payload : (Array.isArray(payload?.projects) ? payload.projects : [])
    projects = entries.filter(project => project && typeof project.slug === 'string')
    renderProjects()
    await refreshPageCounts(projects)
    renderProjects()
  } catch (error) {
    list.setAttribute('aria-busy', 'false')
    list.innerHTML = `<div class="empty-card">${escapeHtml(error.message || i18n.t('hub.loadError'))}<br><small>${escapeHtml(i18n.t('hub.loadErrorHint'))}</small></div>`
  }finally{projectLoadPending=false}
}

const hubText = (english, korean) => i18n.getLanguage() === 'ko' ? korean : english
const metadataId = project => slugPattern.test(project.activity_id || '') ? project.activity_id : project.slug
const metadataFor = project => projectMetadata.get(metadataId(project)) || { project_id: metadataId(project), revision: 0, values: {} }
function projectVenue(project) {
  const values = metadataFor(project).values
  return Object.hasOwn(values, 'venue') ? values.venue : localizedField(project, 'updated_at')
}
function projectSubtitle(project) {
  const values = metadataFor(project).values
  return Object.hasOwn(values, 'description') ? values.description : localizedField(project, 'description')
}
function rememberMetadata(record) {
  if (!record || !slugPattern.test(record.project_id || '') || !Number.isSafeInteger(record.revision) || record.revision < 0 || !record.values || typeof record.values !== 'object' || Array.isArray(record.values)) return false
  if (Object.entries(record.values).some(([key, value]) => !['venue', 'description'].includes(key) || typeof value !== 'string')) return false
  if ((projectMetadata.get(record.project_id)?.revision ?? -1) <= record.revision) projectMetadata.set(record.project_id, record)
  return true
}
async function saveProjectMetadata(project, revision, changes, keepalive = false) {
  const response = await fetch(`/api/backups/projects/${encodeURIComponent(metadataId(project))}/metadata`, {
    method: 'PUT', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
    body: JSON.stringify({expected_revision: revision, changes, actor: currentProfile().name}), signal: AbortSignal.timeout(10000), keepalive
  })
  const payload = await response.json()
  if (payload.metadata?.project_id !== metadataId(project) || !rememberMetadata(payload.metadata)) {
    if (response.ok) throw new Error(hubText('Could not verify the saved value. Try again.', '저장 결과를 확인하지 못했습니다. 다시 시도해 주세요.'))
  }
  if (!response.ok) {
    const error = new Error(response.status === 409
      ? hubText('Someone else edited this project. Check the latest value and save again.', '다른 사람이 먼저 수정했습니다. 최신 값을 확인한 뒤 다시 저장해 주세요.')
      : response.status === 403 ? hubText('You do not have edit access.', '수정 권한이 없습니다.')
      : hubText('Could not save. Your input was kept. Try again.', '저장하지 못했습니다. 입력한 내용은 유지됩니다. 다시 시도해 주세요.'))
    error.conflict = response.status === 409
    throw error
  }
  return payload.metadata
}
function metadataTrigger(project, field) {
  return [...list.querySelectorAll('[data-metadata-field]')].find(button => button.dataset.project === project.slug && button.dataset.metadataField === field)
}
function closeMetadataEditor() {
  if (!metadataEditor) return
  const {dialog, project, field, reposition} = metadataEditor
  metadataEditor = null
  window.removeEventListener('resize', reposition)
  window.visualViewport?.removeEventListener('resize', reposition)
  dialog.close(); dialog.remove()
  metadataTrigger(project, field)?.focus({preventScroll: true})
}
function showMetadataToast(project, field, previous, saved) {
  clearTimeout(metadataToastTimer)
  metadataToast?.remove()
  metadataToast = document.createElement('div')
  metadataToast.className = 'hub-metadata-toast'
  metadataToast.setAttribute('role', 'status')
  metadataToast.innerHTML = `<span>${escapeHtml(field === 'venue' ? hubText('Target venue updated.', '목표 학회를 변경했습니다.') : hubText('Subtitle updated.', '부제목을 변경했습니다.'))}</span><button type="button">${escapeHtml(hubText('Undo', '실행 취소'))}</button>${field === 'venue' ? `<a href="/p/${encodeURIComponent(project.slug)}/rebuttal#overview">${escapeHtml(hubText('Review Rebuttal rules', '리버탈 규정도 확인하기'))}</a>` : ''}`
  const toast = metadataToast, undo = toast.querySelector('button')
  undo.addEventListener('click', async () => {
    clearTimeout(metadataToastTimer); undo.disabled = true
    try {
      await saveProjectMetadata(project, saved.revision, {[field]: previous})
      renderProjects(); toast.querySelector('span').textContent = hubText('Change undone.', '변경을 취소했습니다.'); undo.remove()
    } catch (error) {
      renderProjects()
      toast.querySelector('span').textContent = error.conflict ? hubText('A newer edit exists. Undo was not applied.', '다른 수정이 있어 실행 취소하지 않았습니다.') : hubText('Could not undo. Try again.', '실행 취소하지 못했습니다. 다시 시도해 주세요.')
      if (error.conflict) undo.remove(); else undo.disabled = false
    }
    metadataToastTimer = setTimeout(() => toast.remove(), 15000)
  })
  document.body.append(toast)
  metadataToastTimer = setTimeout(() => toast.remove(), 15000)
}
function openMetadataEditor(project, field) {
  if (!metadataReady || window.PaperAccess?.projects?.[project.slug] === 'viewer') return
  if (field === 'description') { void openSubtitleEditor(project); return }
  if (subtitleEditor) {
    void subtitleEditor.submit(false).then(() => { if (!subtitleEditor) openMetadataEditor(project, field) })
    return
  }
  closeMetadataEditor()
  const record = metadataFor(project), initial = field === 'venue' ? projectVenue(project) : projectSubtitle(project)
  const dialog = document.createElement('dialog')
  dialog.className = 'hub-metadata-dialog'
  dialog.setAttribute('aria-labelledby', 'hub-metadata-title')
  const venueParts = field === 'venue' && initial.match(/^(.*?)\s+(\d{4})$/)
  dialog.innerHTML = `<form><h2 id="hub-metadata-title">${escapeHtml(field === 'venue' ? hubText('Target venue', '목표 학회') : hubText('Subtitle', '부제목'))}</h2><label>${escapeHtml(field === 'venue' ? hubText('Search or enter a venue', '학회 검색 또는 입력') : hubText('Text shown in the project list', '논문 목록에 표시할 설명'))}<input name="value" type="text" maxlength="${field === 'venue' ? 75 : 500}" autocomplete="off" value="${escapeHtml(venueParts ? venueParts[1] : initial)}"></label>${field === 'venue' ? `<label>${escapeHtml(hubText('Year (optional)', '연도 (선택)'))}<input name="year" type="number" min="1900" max="2200" placeholder="2027" value="${escapeHtml(venueParts ? venueParts[2] : '')}"></label><div class="hub-venue-options" role="group" aria-label="${escapeHtml(hubText('Existing venues', '기존 학회'))}"></div>` : ''}<p class="hub-metadata-error" role="alert" hidden></p><div class="hub-metadata-actions"><button type="button" data-cancel>${escapeHtml(hubText('Cancel', '취소'))}</button><button type="submit">${escapeHtml(hubText('Save', '저장'))}</button></div></form>`
  document.body.append(dialog)
  const form = dialog.querySelector('form'), input = form.elements.value, errorText = dialog.querySelector('[role="alert"]')
  const context = {dialog, project, field, revision: record.revision, busy: false}
  metadataEditor = context
  function setBusy(busy) {
    context.busy = busy
    for (const control of form.querySelectorAll('input,button')) control.disabled = busy
    dialog.setAttribute('aria-busy', String(busy))
    form.querySelector('[type="submit"]').textContent = busy ? hubText('Saving…', '저장 중…') : hubText('Save', '저장')
  }
  async function submit(value) {
    if (context.busy) return
    const latest = metadataFor(project), previous = Object.hasOwn(latest.values, field) ? latest.values[field] : null
    if (value === (field === 'venue' ? projectVenue(project) : projectSubtitle(project))) { closeMetadataEditor(); return }
    errorText.hidden = true; setBusy(true)
    try {
      const saved = await saveProjectMetadata(project, context.revision, {[field]: value})
      renderProjects(); closeMetadataEditor(); showMetadataToast(project, field, previous, saved)
    } catch (error) {
      renderProjects()
      if (error.conflict) context.revision = metadataFor(project).revision
      errorText.hidden = false
      errorText.textContent = error.conflict ? `${error.message} ${hubText('Current value:', '현재 값:')} ${field === 'venue' ? projectVenue(project) : projectSubtitle(project)}` : hubText('Could not save. Your input was kept. Try again.', '저장하지 못했습니다. 입력한 내용은 유지됩니다. 다시 시도해 주세요.')
      setBusy(false); input.focus()
    }
  }
  function updateVenueOptions() {
    const labels = [...new Set([...projects.map(projectVenue).filter(Boolean), 'arXiv'])]
      .filter(label => label.toLowerCase().includes(input.value.trim().toLowerCase())).slice(0, 8)
    const options = dialog.querySelector('.hub-venue-options')
    options.innerHTML = [...labels.map(label => `<button type="button" data-venue="${escapeHtml(label)}">${escapeHtml(label)}</button>`), `<button type="button" data-venue="">${escapeHtml(hubText('Unspecified', '미정'))}</button>`].join('')
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    let value = input.value.trim()
    const year = form.elements.year?.value
    if (field === 'venue' && value.toLowerCase() === 'arxiv') value = 'arXiv'
    else if (field === 'venue' && value && year && !value.endsWith(` ${year}`)) value += ` ${year}`
    void submit(value)
  })
  form.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault() })
  form.addEventListener('click', event => {
    const option = event.target.closest('[data-venue]')
    if (option) void submit(option.dataset.venue)
  })
  form.querySelector('[data-cancel]').addEventListener('click', closeMetadataEditor)
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!context.busy) closeMetadataEditor() })
  dialog.addEventListener('click', event => { if (event.target === dialog && !context.busy) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeMetadataEditor() } })
  if (field === 'venue') { input.addEventListener('input', updateVenueOptions); updateVenueOptions() }
  dialog.showModal()
  context.reposition = () => {
    const viewport = window.visualViewport, height = viewport?.height || innerHeight
    const top = viewport?.offsetTop || 0
    dialog.style.maxHeight = `${Math.max(120, height - 24)}px`
    const anchor = metadataTrigger(project, field)?.getBoundingClientRect(), bounds = dialog.getBoundingClientRect()
    dialog.style.left = `${Math.max(12, Math.min(anchor?.left || 12, innerWidth - bounds.width - 12))}px`
    dialog.style.top = `${Math.max(top + 12, Math.min((anchor?.bottom || top + 12) + 6, top + height - bounds.height - 12))}px`
  }
  window.addEventListener('resize', context.reposition)
  window.visualViewport?.addEventListener('resize', context.reposition)
  context.reposition()
  input.focus(); input.select()
}
async function openSubtitleEditor(project) {
  if (subtitleEditor) {
    if (subtitleEditor.project.slug === project.slug) { subtitleEditor.input.focus(); return }
    await subtitleEditor.submit(false)
    if (subtitleEditor) return
  }
  closeMetadataEditor()
  const trigger = metadataTrigger(project, 'description')
  if (!trigger) return
  const initial = projectSubtitle(project), record = metadataFor(project)
  const form = document.createElement('form')
  form.className = 'project-subtitle-inline'
  form.innerHTML = `<input name="value" type="text" maxlength="500" autocomplete="off" aria-label="${escapeHtml(hubText('Edit subtitle', '부제목 수정'))}" aria-describedby="hub-subtitle-hint"><span id="hub-subtitle-hint" class="sr-only">${escapeHtml(hubText('Enter to save, Escape to cancel. Leaving the field also saves.', 'Enter로 저장, Escape로 취소합니다. 다른 곳을 눌러도 저장됩니다.'))}</span><p class="project-subtitle-error" role="alert" hidden></p>`
  const input = form.elements.value, errorText = form.querySelector('[role="alert"]')
  input.value = initial
  const context = {project, input, revision: record.revision, busy: false, pending: null}
  subtitleEditor = context
  function close(restoreFocus) {
    if (subtitleEditor !== context) return
    subtitleEditor = null
    if (!restoreFocus && list.contains(context.blurTarget || document.activeElement)) {
      // Blurring into another row control happens before its click. Rebuilding
      // the list here would remove that control and swallow the user's click.
      const value = projectSubtitle(project)
      trigger.textContent = value || hubText('Add subtitle', '부제목 추가')
      trigger.title = value
      trigger.classList.toggle('is-empty', !value)
      form.replaceWith(trigger)
    } else renderProjects()
    if (restoreFocus) metadataTrigger(project, 'description')?.focus({preventScroll: true})
  }
  context.submit = restoreFocus => {
    if (context.busy) return context.pending
    const value = input.value.trim()
    if (value === initial) { close(restoreFocus); return Promise.resolve() }
    const latest = metadataFor(project)
    const previous = Object.hasOwn(latest.values, 'description') ? latest.values.description : null
    errorText.hidden = true
    input.removeAttribute('aria-invalid')
    context.busy = true
    input.readOnly = true
    form.setAttribute('aria-busy', 'true')
    context.pending = (async () => {
      try {
        const saved = await saveProjectMetadata(project, context.revision, {description: value}, true)
        close(restoreFocus)
        showMetadataToast(project, 'description', previous, saved)
      } catch (error) {
        if (error.conflict) context.revision = metadataFor(project).revision
        errorText.textContent = error.conflict
          ? `${error.message} ${hubText('Current value:', '현재 값:')} ${projectSubtitle(project)}`
          : hubText('Could not save. Your input was kept. Press Enter to retry.', '저장하지 못했습니다. 입력한 내용은 유지됩니다. Enter로 다시 저장해 주세요.')
        errorText.hidden = false
        input.setAttribute('aria-invalid', 'true')
        context.busy = false
        input.readOnly = false
        form.setAttribute('aria-busy', 'false')
        input.focus({preventScroll: true})
      }
    })()
    return context.pending
  }
  form.addEventListener('submit', event => { event.preventDefault(); void context.submit(true) })
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault()
    if (event.key === 'Escape' && !event.isComposing && !context.busy) { event.preventDefault(); close(true) }
  })
  input.addEventListener('blur', event => {
    context.blurTarget = event.relatedTarget
    // A failed save requires an explicit retry, especially after a conflict.
    if (errorText.hidden && subtitleEditor === context) void context.submit(false)
  })
  trigger.replaceWith(form)
  input.focus({preventScroll: true})
}
list.addEventListener('click', event => {
  const trigger = event.target.closest('[data-metadata-field]')
  if (!trigger) return
  event.preventDefault()
  const project = projects.find(item => item.slug === trigger.dataset.project)
  if (project) openMetadataEditor(project, trigger.dataset.metadataField)
})

window.addEventListener('focus',()=>loadProjects())
window.addEventListener('pageshow',event=>{if(event.persisted)loadProjects()})
document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadProjects()})
languagePicker.addEventListener('change', () => i18n.setLanguage(languagePicker.value, { persist: true, updateUrl: true }))
i18n.onChange(() => {
  applyHubLanguage()
  renderCalendar()
  renderProjects()
})
sort.addEventListener('change', () => {
  preferences.set('paper-workspace:project-sort', sort.value)
  renderProjects()
})

applyHubLanguage()
renderCalendar()
loadProjects()
loadSession()
