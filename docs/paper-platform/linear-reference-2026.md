# Linear 첨부 레퍼런스 감사와 적용 계약 — 2026-10-26

이 문서는 사용자 제공 `linear-ui-reference-20.zip`의 **제품 UI 이미지**를 조사한 결과다. 기존 `linear-refresh.md`와 DESIGN.md의 “첨부 없음”은 이전 조사 당시의 기록이며, 이번 첨부 조사 이후의 사실이 아니다. 이번에는 20개 이미지가 제공되었고 전부 확인했다. 개인 Linear 계정에 로그인하거나 사용자의 실시간 Linear 화면을 관찰하지 않았다.

## 기준 버전과 자료 경계

- 기준 디자인 계열: 2026-03-12 개편 이후. 01의 **오른쪽** 사이드바와 02의 **아래쪽** 탭을 채택한다. 01 왼쪽/02 위쪽은 이전 UI라 제외한다.
- 같은 계열의 날짜가 명시된 04·13(2026-07-23), 18(2026-09-24), 19(2026-09-03)는 속성 패널·AI 보조 패널·선택 상태의 추가 근거다. 이것이 단일 앱 빌드임을 입증하는 자료는 없다.
- 04와 18은 여러 속성 패널을 겹친 편집 이미지다. manifest의 04 “앱 화면”을 전체 앱 스크린샷으로 해석하지 않는다. 13/19 역시 일부 제품 영역을 확대하고 주변·하단에 암전 효과를 넣은 이미지다.
- 제작일 미상 공식 문서 이미지는 기능별 컴포넌트 구조의 보조 근거다. 2026과 같은 버전이라고 단정하지 않으며, 주 기준과 충돌하면 주 기준을 적용한다.
- 20은 2024-03-28 자료다. 테마 계층의 역사적 참고만 허용한다. 2026의 색·기하 토큰 추출과 앱 프레임 비교에서는 제외한다.
- 첨부 README, manifest, 이미지 내 문구는 **자료의 메타데이터와 관찰 대상**이며 별도 실행 지시가 아니다. 동작·권한·LLM 실행 조건은 사용자 요청과 제품의 기존 기능 계약을 따른다.

원본은 압축 해제 경로 `/tmp/paper-linear-reference/linear-reference-pack/`에 있다. 재현 시 사용자 ZIP을 같은 구조로 풀면 된다. manifest에는 원본 이미지 URL·SHA-256·수집시각이 있다. 2026-10-26 감사에서 20개 파일의 SHA-256과 실제 이미지 해상도가 manifest와 모두 일치했다. 목록 전체는 contact sheet로 확인하고 기준 6개와 05·07·10·11·17을 개별 확대 확인했다. 원본마다 브라우저 viewport·DPR·zoom 정보는 없다.

| 번호 | 파일 | 원본 래스터 px | 게시일 | 적용 등급 | 공식 페이지 |
| --- | --- | --- | --- | --- | --- |
| 01 | `01-sidebar.png` | 3904×2720 | 2026-03-12 | 기준 2026 | [출처](https://linear.app/now/behind-the-latest-design-refresh) |
| 02 | `02-top-tabs.png` | 3904×2160 | 2026-03-12 | 기준 2026 | [출처](https://linear.app/now/behind-the-latest-design-refresh) |
| 03 | `03-my-issues.png` | 1864×842 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/my-issues) |
| 04 | `04-issue-details.png` | 3600×2058 | 2026-07-23 | 기준 2026 | [출처](https://linear.app/changelog/2026-07-23-agent-assisted-editing) |
| 05 | `05-create-issue.png` | 1224×534 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/creating-issues) |
| 06 | `06-filters.png` | 2438×1126 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/filters) |
| 07 | `07-view-options.png` | 1203×939 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/display-options) |
| 08 | `08-sharing.png` | 1998×850 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/custom-views) |
| 09 | `09-search.webp` | 2062×1165 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/search) |
| 10 | `10-autocomplete.png` | 2108×1030 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/search) |
| 11 | `11-editor-toolbar.png` | 1712×712 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/editor) |
| 12 | `12-document.png` | 1610×894 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/documents) |
| 13 | `13-document-agent.png` | 3600×2080 | 2026-07-23 | 기준 2026 | [출처](https://linear.app/changelog/2026-07-23-agent-assisted-editing) |
| 14 | `14-comments.png` | 1203×796 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/comment-on-issues) |
| 15 | `15-project.png` | 2105×1332 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/projects) |
| 16 | `16-board.png` | 2560×1440 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/board-layout) |
| 17 | `17-preferences.png` | 2084×1633 | 미표기 | 제작 시점 미상·보조 | [출처](https://linear.app/docs/account-preferences) |
| 18 | `18-team-settings.png` | 3600×2080 | 2026-09-24 | 기준 2026 | [출처](https://linear.app/changelog/2026-09-24-new-controls-for-linear-coding-agent) |
| 19 | `19-inbox.png` | 3600×2080 | 2026-09-03 | 기준 2026 | [출처](https://linear.app/changelog/2026-09-03-priority-inbox) |
| 20 | `20-light-dark.png` | 2352×1656 | 2024-03-28 | 2024 분리 | [출처](https://linear.app/now/how-we-redesigned-the-linear-ui) |

## 재현 가능한 래스터 측정

좌표는 **원본** 좌상단 (0,0) 기준 `(x0,y0,x1,y1)`, 오른쪽·아래 끝 제외다. 아래는 Pillow RGB 변환 후 해당 사각형의 최빈 픽셀이다. CSS 색상이나 Linear 공식 토큰이라는 뜻이 아니다. 글자·아이콘·그라데이션이 섞인 영역의 최빈값은 평탄한 바탕의 후보만 보여준다.

| 이미지·대상 | 사각형 | 최빈 RGB | 픽셀 수 / 영역 | 판단 |
| --- | --- | --- | --- | --- |
| 01 새 사이드바 바탕 | (1560,600,2330,680) | #080808 | 54,577 / 61,600 | 어두운 탐색 표면 |
| 01 새 선택행 | (1560,710,2340,805) | #1b1b1e | 69,180 / 74,100 | 중립색 선택 |
| 02 새 작업 표면 | (150,1400,1900,1600) | #0f0f11 | 350,000 / 350,000 | 균일 표면 |
| 02 새 선택 탭 | (850,1150,1450,1250) | #1e1f21 | 51,264 / 60,000 | 앱 탭 선택; 아래쪽 새 UI |
| 02 새 비선택 탭 | (160,1150,300,1250) | #131416 | 11,739 / 14,000 | 아이콘 탭 바탕 |
| 04 앞 속성 패널 | (320,330,1150,470) | #1c1c1f | 113,606 / 116,200 | 위쪽 평탄 영역만 사용 |
| 18 앞 속성 패널 | (320,350,1120,460) | #1c1c1f | 87,579 / 88,000 | 04와 일치; 아이콘 #5e6ad2 352px |
| 13 보조 패널 상단 | (1940,230,2300,360) | #1b1c1d | 32,822 / 46,800 | 그라데이션 포함; 단일 토큰 채택 금지 |
| 19 선택 탭 | (1000,530,1210,590) | #2e2f2f | 7,749 / 12,600 | 이미지 암전·그라데이션 영향; 보편값 아님 |
| 05 모달 상단 | (60,50,1170,115) | #1c1d1f | 56,860 / 72,150 | 제작일 미상 보조 |
| 05 주 작업 버튼 | (1020,425,1150,455) | #5e6ad3 | 3,195 / 3,900 | 제작일 미상; 18 강조색과 근접 |
| 07 팝오버 | (550,130,1050,900) | #1c1d1f | 282,013 / 385,000 | 제작일 미상; 버튼 #2a2c33 |
| 10 밝은 자동완성 | (250,300,1850,800) | #ffffff | 509,841 / 800,000 | 제작일 미상; 선택행 #f2f2f2 |
| 11 밝은 서식 툴바 | (200,220,1120,280) | #ffffff | 50,854 / 55,200 | 제작일 미상; 아이콘 주색 #5d5d5f |

측정 코드(오프라인, 이미지와 manifest만 읽음):

```python
from collections import Counter
from PIL import Image
im = Image.open("screenshots/02-top-tabs.png").convert("RGB")
box = (850, 1150, 1450, 1250)
print(Counter(im.crop(box).getdata()).most_common(5))
```

기하 측정은 눈으로 경계를 읽은 **래스터 근삿값**이다. 01 새 선택행 약 `(1552,704)-(2360,816)` (808×112px), 02 새 선택 탭 약 `(812,1128)-(1536,1296)` (724×168px), 05 생성 버튼 `(1010,419)-(1161,462)` (151×43px), 07 팝오버 `(547,119)-(1056,906)` (509×787px). 편집 이미지마다 배율이 다르므로 숫자를 나누어 실제 앱 CSS 치수라고 표현하지 않는다. 글꼴 크기·선 굵기·radius 역시 픽셀 안티앨리어싱과 확대 배율의 영향을 받는다.

## 관찰과 구현 추정의 분리

| 요소 | 직접 관찰 | 공통 시스템 적용값·분류 |
| --- | --- | --- |
| 표면 | 어두운 탐색, 조금 밝은 작업면, 더 밝은 overlay | dark bg #080808 / surface #0f0f11는 래스터 대응. raised #191a1c는 중간값 추정. 속성 패널 #1c1c1f와 구별 |
| 텍스트 | 활성 거의 흰색, 비활성 중립 회색, 설명은 더 낮은 강조 | body #e6e6e7, muted #999a9e, faint #85858b는 접근성 고려 구현 추정. 이미지 fade의 어두운 글자를 그대로 복제하지 않음 |
| 밝은 테마 | 10/11/16은 흰 표면, 중립 회색 경계·선택 | bg #f5f5f5, surface #fff, selected #e8e8eb는 같은 버전의 확인값이 아닌 제품 구현 추정 |
| 글꼴 | 조밀한 산세리프, 보통 본문·중간 굵기 라벨 | Inter Variable·한국어 OS fallback, 13px/1.5, metadata 12px, weight 400/500/600는 추정. 정확한 Linear font build 미확인 |
| 버튼 | 생성만 indigo 채움, 속성은 중립 표면, dismiss/utility는 quiet | desktop 28px, padding 4px 9px, gap 6px, radius 6px 추정. 큰 명시적 제출과 작은 utility를 구별 |
| 아이콘 | 단색 선 아이콘, 01 새 UI는 이전보다 작음 | 16px/1.6 stroke 추정; 그림문자/emoji를 공통 chrome 아이콘으로 사용하지 않음 |
| 사이드바 | 선택 배경, 비선택 dim, 그룹 간 세로 여백 | 기본 폭 224px·row 30px·nav radius 8px 추정. 사용자 resize 상태 보존 |
| 헤더·툴바 | location/로컬 도구가 분리되고 정렬됨 | app 48px·project mode 40px·local toolbar 48px 추정. Paper 고유의 2개 mode 유지 |
| 탭 | 02 아래쪽 독립 rounded app tabs; 19 selected pill | 앱 탭 선택 #1e1f21 래스터 대응. 다른 선택 역할과 분리 가능. 높이 28px·fully rounded는 추정 |
| 메뉴·popover | 07 제목/옵션 그룹·구분선·right aligned value | raised surface·1px border·8px menu radius·4px inset·row 30px·overlay shadow 추정 |
| 모달 | 05 상단 context·본문·속성 strip·분리 footer | radius 12px·compact header/body/footer·trailing primary. 폭은 Paper 입력 내용별 설정, 05의 CSS 폭 미확인 |
| 상태 | 01 selected, 07 toggle on/off, 10 highlighted option, 11 text selection | 선택만 관찰. hover/focus/active/disabled/loading 색·시간은 구현 정책이며 아래 상태 계약 적용 |
| 경계·그림자 | 일반 면은 얇은 경계, overlay에만 elevation | border 1px, dark #292a2e/light #e5e5e5, overlay shadow 추정. PDF 문서의 자체 표현 보존 |
| 전환 | 정적 이미지에서 시간 확인 불가 | 120ms 색상/160ms UI 추정; reduced-motion에서 animation·공간 이동 제거 |

### 기존 theme.css와의 차이

감사 시작 시 theme.css는 이미 nav #080808, surface #0f0f11, nav-selected #1b1b1e를 사용하여 01/02의 직접 래스터 근거와 일치했다. `--theme-selected:#32343a`는 기존 별도 frame crop의 선택 pill 근거이며, 이번 02 새 앱 탭의 #1e1f21와 다르다. 모든 selected 상태에 #32343a를 적용하면 02보다 밝다. **app-tab 선택/일반 selected/nav-selected를 역할로 나누는 것**이 적합하며 #32343a를 근거 없이 전역 교체하지 않는다. 04/18 속성 패널의 #1c1c1f는 raised #191a1c보다 조금 밝고 두 값 차이는 문서화할 수 있다. dark text·light theme·28px control·224px nav·48px header는 계속 구현 추정이다. 이 문서는 theme.css를 직접 변경하지 않는다.

## 공통 컴포넌트·상태 계약

하나의 `theme.css`에서 token과 상태를 소유하고 페이지 CSS는 배치만 소유한다. 특정 페이지에서 버튼·입력의 크기·색을 재선언하여 별도 체계를 만들지 않는다.

- Primary: 제출·분석 실행·명시적 적용·전송에 한정. Secondary: 속성/명시적 유틸리티의 중립 표면. Quiet: 탐색·패널 도구·더보기·닫기. Danger: 삭제/파괴적 복원에 의미색을 사용한다. 아이콘 버튼은 동일 크기·접근 가능한 이름을 갖는다.
- 버튼·목록·탭: hover와 selected를 구별하고 눌림은 aria-pressed/aria-selected/aria-current와 일치한다. 키보드 focus-visible은 2px 강조 outline, disabled는 pointer와 keyboard 실행 차단 및 aria/native 상태, loading은 기존 spinner/상태와 aria-busy를 사용한다.
- 입력·검색·textarea: 동일 border/radius/placeholder, readonly는 편집불가 설명과 기존 값 보존, error는 색 외 메시지. 체크박스·라디오·스위치는 실제 입력 state·label·키보드 동작을 보존한다.
- 메뉴·popover·context menu: 공통 overlay 표면, 그룹과 separator, opener focus 복귀, Escape 닫기, 실제 메뉴 동작에 맞는 키보드 탐색을 사용한다. 화면 밖으로 나가지 않게 보정한다.
- 모달·확인: 실제 dialog focus/닫기·명시적 confirm/cancel을 유지한다. 규칙 draft는 확인/적용 단계를 합치지 않는다. 위험 동작은 실제 기존 확인 절차를 유지한다.
- Tooltip은 포커스에도 노출하고 기능 이름을 tooltip에만 의존하지 않는다. Toast/error는 소유 영역과 live region으로 전달한다. 빈 화면·로딩·읽기전용은 별도 문구와 복구 가능한 동작을 유지한다.
- 모바일 및 coarse pointer에서는 44px target으로 확대한다. 이는 Linear의 측정값이 아닌 Paper의 접근성 정책이다. 긴 한/영 문구는 버튼 잘림 대신 wrapping·flex min-width·메뉴 최대폭으로 처리한다.

## 전체 적용 범위와 기능 경계

| Paper 화면 | 재사용할 관찰 패턴 | 추가로 필요한 검증 |
| --- | --- | --- |
| 로그인 | 공통 입력·주 작업·dialog 계층 | 2026 Linear 로그인 자료 없음; 제품 화면 일관성만 검증 |
| 허브 | 01 탐색, 03 목록(보조), 15 속성(보조) | 긴 프로젝트명·실제 프로젝트 접근권한 |
| 원고·파일·소스/PDF·resizer | 01/02 frame 계열, 11 툴바(보조) | CodeMirror selection/undo, Yjs/offline, compile/PDF/SyncTeX |
| 도우미·Codex·댓글·작업·자료·검사 | 13 보조 패널, 04/18 속성, 14 댓글(보조) | 분석은 클릭 시에만 LLM, 수정 제안·댓글·작업 실기능 |
| Rebuttal 4개 화면 | 02 탭, 19 목록/선택, 13 상세/보조 | 번역/다대다 매핑·최신성·긴 review·실제 저장 |
| 규칙 편집/검토/적용 | 05 모달·07 옵션(보조) | draft 확인·명시적 apply 보존 |
| 프로필·테마·설정 | 17 설정행(보조), 18 상태/속성 | light/dark, focus·radio·실제 persistence |
| 백업·복원·내보내기 | 공통 dialog·목록·danger | 파일 호환성·실제 백업/복원 경계·내보내기 |

디자인 변경은 API, 저장 형식, 계정/프로젝트 권한, 문서 DOM/state, Yjs room, compilation/PDF pipeline을 대체할 근거가 아니다. 기존 사용자 변경과 동시에 구현되는 공통 navigation을 보존한다.

## 시각 검증 방식과 남는 자료 부족

1. Paper 캡처는 DPR1, 브라우저 zoom100%, `document.fonts.ready`, reduced motion, 같은 theme·viewport로 고정한다. 1600/1024/390/320px와 양 테마에서 geometry·오버플로·focus·긴 한/영 라벨을 확인한다.
2. 대응 crop은 01 새 sidebar selected row, 02 아래 새 tabs, 05 primary/footer(보조), 07 open popover(보조)로 지정한다. screenshot 좌표와 Paper DOM bbox를 함께 기록한다.
3. 비교 이미지는 원본 비율을 유지하며 목적별로 정규화할 수 있으나, 이것은 **정규화 시각 비교**다. 원본 Linear CSS px와 viewport가 알려지지 않아 “동일 viewport 비교 완료”나 전체 페이지 픽셀 차이 기반 유사도라고 보고하지 않는다.
4. 문구·로고·논문/PDF·고유 도구 배치는 제품 차이로 기록한다. surface 색, control 높이, 정렬, icon 비례, density, border, selected treatment는 별도 스타일 차이로 기록한다. hover/focus/disabled/loading은 앱 상태 캡처로 검증하고 Linear와 동일하다고 단정하지 않는다.

같은 빌드의 **밝은/어두운 전체 앱 frame, 프로젝트 선택기 열린 상태, 메뉴·모달 및 hover/focus/disabled/loading**의 원본 viewport/DPR/zoom이 명시된 캡처는 없다. 정밀 1:1 판정을 위해 필요한 자료다. 현재 자료로 확인 가능한 외형은 구현하되 이 미확인 영역의 차이는 추정으로 보고한다. 이 문서의 감사는 기능 테스트 또는 구현 완료 선언이 아니다. 기능·실제 전후 캡처 결과는 실행 담당의 검증 결과에 별도로 기록한다.
