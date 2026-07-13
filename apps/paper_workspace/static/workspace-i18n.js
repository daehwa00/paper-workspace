(() => {
  const i18n = window.PaperI18n
  if (!i18n) return
  const en = {
    '논문 허브': 'Paper hub', '논문 허브로 돌아가기': 'Back to paper hub', '논문 제목': 'Paper title',
    '작업공간 상태 보기': 'View workspace status', '연결 중': 'Connecting', '화면 모드 설정': 'Appearance settings',
    '표시 이름 변경': 'Change display name', '접속 중인 공동 편집자': 'Active collaborators', '작업 화면': 'Workspace view',
    '파일': 'Files', '원고': 'Source', '도우미': 'Assistant', '프로젝트 파일': 'Project files',
    '프로젝트 파일 접기': 'Collapse project files', '프로젝트 파일 펼치기': 'Expand project files', '새 폴더': 'New folder', '새 파일': 'New file',
    '여기에 놓아 추가': 'Drop to add', '파일과 폴더를 프로젝트로 가져옵니다': 'Import files and folders into this project', '논문 파일': 'Paper files',
    '프로젝트 파일 패널 폭 조절': 'Resize project files panel', '로컬 원고 불러오는 중': 'Loading local source',
    '편집기 확대·축소': 'Editor zoom', '편집기 축소': 'Zoom editor out', '편집기 확대': 'Zoom editor in',
    '서버 원본이 변경되었습니다': 'The server source changed', '브라우저 초안은 drafts에 보존하고 최신 서버 원본을 열었습니다.': 'Your browser draft was preserved in drafts and the latest server source was opened.',
    '보존한 초안 열기': 'Open preserved draft', 'LaTeX 편집기': 'LaTeX editor', '현재 파일의 댓글 위치': 'Comment locations in the current file',
    '그림 미리보기': 'Asset preview', '그림 확대·축소': 'Asset zoom', '그림 축소': 'Zoom asset out', '그림 확대': 'Zoom asset in',
    '다운로드': 'Download', '브라우저 미리보기를 지원하지 않는 파일': 'Browser preview is unavailable for this file',
    '파일을 다운로드해 외부 앱에서 열 수 있습니다.': 'Download the file to open it in another application.',
    '편집기와 PDF 미리보기 사이 폭 조절': 'Resize source and PDF panels', '렌더링 대기': 'Waiting to render', '현재 PDF 페이지': 'Current PDF page',
    'PDF 확대·축소': 'PDF zoom', 'PDF 축소': 'Zoom PDF out', 'PDF 확대': 'Zoom PDF in', '렌더링된 PDF 다운로드': 'Download rendered PDF', 'PDF 새로고침': 'Refresh PDF',
    '현재 PDF는 마지막 정상 빌드이며 최신 원고와 다릅니다.': 'This is the last successful PDF and does not match the latest source.',
    '논문 미리보기': 'Paper preview', 'PDF 준비 중': 'Preparing PDF', '원고를 렌더링하고 있습니다': 'Rendering the manuscript', '첫 페이지 준비 중': 'Preparing first page', '첫 페이지를 먼저 표시합니다': 'Rendering the first page first', 'PDF 렌더링을 실행하면 여기에 표시됩니다': 'The rendered PDF will appear here.', 'PDF 렌더링을 시작하면 여기에 표시됩니다': 'The rendered PDF will appear here.',
    'PDF 미리보기와 논문 도우미 사이 폭 조절': 'Resize PDF and assistant panels', '논문 도우미': 'Paper assistant',
    '논문 도우미 접기': 'Collapse paper assistant', '논문 도우미 펼치기': 'Expand paper assistant', '패널 폭 초기화': 'Reset panel widths', '논문 도우미 도구': 'Paper assistant tools',
    '수정': 'Revise', '댓글': 'Comments', '자료': 'Sources', '검사': 'Checks', '작업': 'Tasks',
    '선택 영역을 바로 다듬어 보세요': 'Refine a selection in place', '선택한 문장과 현재 원고 문맥을 함께 읽어 수정합니다.': 'Codex reads the selection with its surrounding manuscript context.',
    '어떻게 다듬을까요?\n예: 주장 범위는 유지하고 학술 문체로 간결하게 수정해줘': 'How should it be revised?\nExample: Preserve the claim scope and make the academic prose concise.',
    'Codex 수정 요청': 'Codex revision request', '모델 설정': 'Model settings', '모델 설정 ·': 'Model settings ·', '단문·문법·표현만 빠르게 수정할 때 적합합니다.': 'Best for quick sentence-level grammar and expression edits.',
    '논문 문단 전체를 자연스럽고 일관되게 다듬을 때 적합합니다.': 'Best for polishing a full paragraph naturally and consistently.',
    '논리 구조와 주장 강도까지 함께 검토할 때 적합합니다.': 'Best for reviewing logic and claim strength together.',
    'Codex에게 요청 보내기': 'Send request to Codex', '보낸 요청': 'Sent request', '새 요청': 'New request',
    '문장에 대화를 연결하세요': 'Start a discussion on a sentence', '본문을 선택하고 남긴 댓글은 해당 문장과 revision에 연결됩니다.': 'Comments on a selection remain linked to that sentence and revision.',
    '@공동저자에게 질문 또는 검토 요청': '@Ask a coauthor a question or request review', '선택 영역에 댓글 남기기': 'Comment on selection', '아직 댓글이 없습니다.': 'No comments yet.',
    '원고 근거를 한곳에 모으세요': 'Keep manuscript evidence together', '업로드한 데이터, 그림, 메모와 참고문헌을 함께 관리합니다.': 'Manage uploaded data, figures, notes, and references together.',
    '아직 업로드한 자료가 없습니다.': 'No uploaded sources yet.', '버전 이름 (예: submission-v1)': 'Version name (e.g. submission-v1)', '저장할 버전 이름': 'Version name to save',
    '지금 백업': 'Back up now', '버전 저장': 'Save version', '10분 자동 백업과 이름 있는 중요 버전을 서버에 보관합니다. 복원 전 현재 상태도 자동 보존됩니다.': 'Ten-minute automatic backups and named milestones are stored on the server. The current state is preserved before a restore.',
    '제출 전 위험 요소를 확인하세요': 'Check submission risks', '원고, 참고문헌, 자산과 마지막 PDF를 함께 검사합니다.': 'Check the manuscript, references, assets, and latest PDF together.',
    '제출 준비 검사': 'Submission readiness', '현재 원고·참고문헌·자산과 마지막 PDF를 함께 검사합니다.': 'Inspect the current source, references, assets, and latest PDF.',
    '전체 검사 실행': 'Run all checks', '아직 검사하지 않았습니다.': 'Not checked yet.', '컴파일 오류': 'Compile errors', '클릭하여 이동': 'Click to navigate',
    'Figure · Table 자산': 'Figure · Table assets', '새 BibTeX 항목을 붙여넣으세요. 기존 citation key는 중복 추가하지 않습니다.': 'Paste new BibTeX entries. Existing citation keys will not be duplicated.',
    'BibTeX 가져오기': 'Import BibTeX', '제출 패키지': 'Submission package', '현재 소스와 필요한 자산, 파일 해시를 하나의 ZIP으로 만듭니다.': 'Create one ZIP containing the current source, required assets, and file hashes.',
    'Source ZIP 만들기': 'Build source ZIP', '다음 작업을 놓치지 마세요': 'Keep track of next steps', '할 일과 담당자, 관련 파일 위치를 함께 관리합니다.': 'Manage tasks, owners, and related source locations together.',
    '할 일 입력': 'Add a task', '추가': 'Add', '협업을 시작하기 전에': 'Before collaborating', '표시 이름을 설정하면 공동저자가 누가 작업 중인지 알 수 있어요.': 'Set a display name so coauthors know who is working.',
    '이름 설정': 'Set name', '작업공간 상태': 'Workspace status', '상태 창 닫기': 'Close status panel', '공동 편집': 'Collaboration', '브라우저 저장': 'Browser save',
    '상태 확인 중': 'Checking status', '다시 연결': 'Reconnect', '검사 보기': 'View checks', '선택한 텍스트 작업': 'Selection actions',
    '선택한 문장에 댓글 남기기': 'Comment on the selected sentence', '선택 영역 댓글': 'Selection comment', '등록': 'Add comment',
    '인라인 댓글 닫기': 'Close inline comment', '선택한 문장을 어떻게 수정할까요?': 'How should the selected sentence be revised?', '보내기': 'Send',
    '인라인 Codex 요청 닫기': 'Close inline Codex request', '오른쪽 클릭 메뉴': 'Context menu', '하위 폴더': 'Subfolder', '이름 변경': 'Rename', '삭제': 'Delete',
    '표시 이름 설정': 'Set display name', '공동 편집자에게 보이는 이름입니다.': 'This name is visible to collaborators.', '표시 이름': 'Display name', '프로필 색상': 'Profile color',
    '파랑': 'Blue', '보라': 'Purple', '청록': 'Cyan', '초록': 'Green', '주황': 'Orange', '빨강': 'Red', '분홍': 'Pink',
    '취소': 'Cancel', '저장': 'Save', '확인': 'Confirm', '닫기': 'Close', '화면 모드': 'Appearance', '이 브라우저의 허브와 모든 논문에 함께 적용됩니다.': 'Applies to the hub and every paper in this browser.',
    '시스템': 'System', '기기 설정에 맞춰 자동 전환': 'Follow the device setting', '라이트': 'Light', '밝은 작업 화면을 항상 사용': 'Always use a light workspace',
    '다크': 'Dark', '어두운 작업 화면을 항상 사용': 'Always use a dark workspace', '완료': 'Done', '서버 원고 복구됨 · 로컬 편집 모드': 'Server source recovered · local editing mode',
    '전체 기능을 복구하려면 새로고침': 'Reload to restore all features', '로컬 편집': 'Local editing', '정상': 'Healthy', '처리 중': 'In progress',
    '편집기 호환 모드': 'Editor compatibility mode', '전문 편집기를 시작하지 못해 기본 편집기로 복구했습니다. 원고는 정상적으로 불러옵니다.': 'The professional editor could not start, so the basic editor was restored. Your source loaded normally.',
    '공유 자산 목록을 불러오지 못했습니다.': 'Could not load shared assets.', '프로젝트 설정 오류': 'Project configuration error', '프로젝트를 불러오지 못했습니다.': 'Could not load the project.',
    '공유 자산 연결 지연': 'Shared asset connection delayed', '서버 원고 표시됨 · 공동 편집 병합 중': 'Server source shown · merging collaboration updates', 'PDF 미리보기 로드됨': 'PDF preview loaded',
    '원고 로드 오류': 'Source loading error', '원고를 불러오지 못했습니다.': 'Could not load the source.', '일부 기능 호환 모드': 'Limited compatibility mode',
    '저장됨': 'Saved', '저장됨 · 공동 편집 동기화': 'Saved · collaboration synced', '공동 편집 전송 중…': 'Sending collaboration update…', '로컬 저장 중…': 'Saving locally…', '로컬 저장됨 · 동기화 대기': 'Saved locally · waiting to sync',
    '로컬 저장됨 · 큰 자료 제외': 'Saved locally · large assets excluded', '저장 공간 부족': 'Storage is full', '시간 정보 없음': 'Time unavailable', '백업 기록이 없습니다.': 'No backup history.',
    '등록된 작업이 없습니다.': 'No tasks yet.', '담당자 없음': 'Unassigned', '프로젝트': 'Project', '깨끗한 컴파일 확인 중…': 'Checking a clean compile…', '패키지 생성 중…': 'Building package…',
    '패키지 생성 실패': 'Package creation failed', '컴파일 실패': 'Compile failed', '검사 탭에서 오류 위치를 확인하세요': 'Open Checks to inspect the error location.',
    'PDF를 만들지 못했습니다': 'Could not build the PDF', '마지막 정상 PDF는 그대로 유지됩니다.': 'The last successful PDF is preserved.', '아직 표시할 정상 PDF가 없습니다.': 'No successful PDF is available yet.', '아직 표시할 정상 PDF가 없습니다. 검사 탭의 오류를 누르면 해당 줄로 이동합니다.': 'No successful PDF is available yet. Click an error in Checks to navigate to its source line.',
    'PDF 컴파일 오류': 'PDF compile error', 'PDF를 만들지 못했습니다. 검사 탭에서 오류 위치를 확인하세요.': 'Could not build the PDF. Open Checks to inspect the error location.', '컴파일 오류 확인': 'View compile error', '기존 브라우저 초안을 drafts에 보존했습니다.': 'The previous browser draft was preserved in drafts.', '서버 원본 변경 감지': 'Server source change detected',
    '선택한 원문이 변경되었습니다. 문장을 다시 선택해 주세요.': 'The selected source changed. Select the sentence again.',
    'Codex 요청 이후 원문이 변경되어 자동 적용하지 않았습니다. 다시 선택해 주세요.': 'The source changed after the Codex request, so the revision was not applied. Select it again.',
    '유효한 BibTeX 항목을 찾지 못했습니다.': 'No valid BibTeX entry was found.', '모든 citation key가 이미 존재합니다.': 'All citation keys already exist.',
    '현재 소스가 컴파일되지 않아 패키지를 만들지 않았습니다. 오류를 먼저 해결해 주세요.': 'The source does not compile, so no package was created. Fix the errors first.',
    '필요할 때 불러옴': 'loaded on demand', '같은 이름의 파일이 이미 있습니다.': 'A file with this name already exists.', '같은 이름의 폴더가 이미 있습니다.': 'A folder with this name already exists.',
    '공유 자료 이름 변경 실패': 'Could not rename shared asset', '공유 자료 삭제 실패': 'Could not delete shared asset'
  }
  i18n.register('en', en)
  i18n.register('ko', Object.fromEntries(Object.keys(en).map(key => [key, key])))

  const patterns = [
    [/^(.*) 컴파일 중…$/, (_, file) => `${file} ${i18n.getLanguage() === 'ko' ? '컴파일 중…' : 'compiling…'}`],
    [/^(.*) 최신 · 캐시$/, (_, file) => i18n.getLanguage() === 'ko' ? `${file} 최신 · 캐시` : `${file} current · cached`],
    [/^(.*) 최신 · ([0-9.]+)초$/, (_, file, seconds) => i18n.getLanguage() === 'ko' ? `${file} 최신 · ${seconds}초` : `${file} current · ${seconds}s`],
    [/^(.*) 컴파일 오류$/, (_, file) => i18n.getLanguage() === 'ko' ? `${file} 컴파일 오류` : `${file} compile error`],
    [/^(.*) 오류 · 이전 PDF$/, (_, file) => i18n.getLanguage() === 'ko' ? `${file} 오류 · 이전 PDF` : `${file} error · previous PDF`],
    [/^(\d+)개 검사 · 오류 (\d+) · 확인 필요 (\d+)$/, (_, total, errors, warnings) => i18n.getLanguage() === 'ko' ? `${total}개 검사 · 오류 ${errors} · 확인 필요 ${warnings}` : `${total} checks · ${errors} errors · ${warnings} warnings`],
    [/^최근 백업 (.+)$/, (_, date) => i18n.getLanguage() === 'ko' ? `최근 백업 ${date}` : `Latest backup ${date}`],
    [/^(\d+)개 항목을 (.*)에 추가했습니다\.$/, (_, count, file) => i18n.getLanguage() === 'ko' ? `${count}개 항목을 ${file}에 추가했습니다.` : `Added ${count} entries to ${file}.`]
  ]
  function translate(value) {
    if (i18n.getLanguage() === 'ko') return value
    const leading = value.match(/^\s*/)?.[0] || '', trailing = value.match(/\s*$/)?.[0] || ''
    const core = value.slice(leading.length, value.length - trailing.length || undefined)
    if (!core) return value
    if (Object.prototype.hasOwnProperty.call(en, core)) return `${leading}${en[core]}${trailing}`
    for (const [pattern, render] of patterns) if (pattern.test(core)) return `${leading}${core.replace(pattern, render)}${trailing}`
    return value
  }
  const excluded = '.cm-editor,#editor,#asset-stage,#project-title,.file-label,.comment-body,.task-label,.codex-proposal,.codex-request-text,.diff-block,.latex-preview'
  const textState = new WeakMap(), attributeState = new WeakMap(), attributes = ['aria-label', 'title', 'placeholder']
  const excludedNode = node => Boolean((node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(excluded))
  function translateTextNode(node) {
    if (excludedNode(node)) return
    let state = textState.get(node)
    if (!state || node.nodeValue !== state.rendered) state = { source: node.nodeValue, rendered: node.nodeValue }
    if (!/[가-힣]/.test(state.source || '')) return
    const rendered = i18n.getLanguage() === 'ko' ? state.source : translate(state.source)
    state.rendered = rendered; textState.set(node, state)
    if (node.nodeValue !== rendered) node.nodeValue = rendered
  }
  function translateElement(element) {
    if (excludedNode(element)) return
    let states = attributeState.get(element); if (!states) { states = {}; attributeState.set(element, states) }
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute), old = states[attribute]
      if (!value && !old) continue
      if (!old || value !== old.rendered) states[attribute] = { source: value || '', rendered: value || '' }
      const state = states[attribute]; if (!/[가-힣]/.test(state.source)) continue
      const rendered = i18n.getLanguage() === 'ko' ? state.source : translate(state.source)
      state.rendered = rendered; if (value !== rendered) element.setAttribute(attribute, rendered)
    }
  }
  function localize(root = document.body) {
    if (!root) return
    if (root.nodeType === Node.TEXT_NODE) translateTextNode(root); else if (root.nodeType === Node.ELEMENT_NODE) translateElement(root)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let node
    while ((node = walker.nextNode())) node.nodeType === Node.TEXT_NODE ? translateTextNode(node) : translateElement(node)
    const description = document.querySelector('meta[name="description"]')
    const localizedDescription = i18n.getLanguage() === 'ko' ? '공동 논문 편집과 PDF 렌더링을 위한 Paper Workspace' : 'A collaborative LaTeX workspace with live editing and PDF rendering.'
    if (description) description.content = localizedDescription
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', localizedDescription)
    document.querySelector('meta[property="og:locale"]')?.setAttribute('content', i18n.getLanguage() === 'ko' ? 'ko_KR' : 'en_US')
  }
  function installLanguageControl() {
    const select = document.getElementById('workspace-language'); if (!select) return
    const update = language => { select.value = language; select.setAttribute('aria-label', language === 'ko' ? '언어 선택' : 'Language') }
    update(i18n.getLanguage()); select.addEventListener('change', () => i18n.setLanguage(select.value, { persist: true, updateUrl: true }))
    i18n.onChange(language => { update(language); localize(document.body) })
  }
  const observer = new MutationObserver(records => { for (const record of records) { if (record.type === 'characterData') translateTextNode(record.target); else if (record.type === 'attributes') translateElement(record.target); else for (const node of record.addedNodes) localize(node) } })
  function start() { installLanguageControl(); localize(document.body); observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes }) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start()
  window.WorkspaceI18n = Object.freeze({ localize, translate })
})()
