# 공개 Linear 추가 참조 감사 · 2026-10-27

이 디렉터리는 공개 Linear 앱에서 실제로 렌더링한 화면과 DOM computed style 측정만 담는다. Paper의 HTML/CSS/JS는 수정하지 않았다. 인증·폼 제출·LLM 요청·프로젝트/이슈 생성·설정 저장을 하지 않았다. 이메일 필드에는 `reference@example.invalid`만 입력하고 제출하지 않았다. 버튼·메뉴 열기와 페이지 이동은 실제 UI 조작이다. CDN 자산은 기존 `linear_public_asset_transport.mjs`가 검증한 원래 바이트를 제공했고 API 응답은 대체하지 않았다.

공통 조건: Chromium, viewport 1600×1000 CSS px, DPR 1, visualViewport.scale 1, light/dark OS preference 각각, document.fonts.ready 완료, reduced-motion, screenshot animations disabled. JSON의 `time`은 UTC이며 한국 시간은 2026-10-27이다. 값은 getBoundingClientRect / getComputedStyle 직접 관찰이다. 첨부 이미지와 같은 빌드인지는 확인되지 않았다.

## 로그인 — 실제 확인

URL: https://linear.app/login

최종값은 `login-summary.json`을 기준으로 한다. 초기 포인터가 이메일 버튼 위에 남아 있던 측정은 hover였음을 확인했고, 포인터를 화면 우하단으로 옮긴 기본 상태와 다시 hover한 상태를 분리하여 최종 JSON/PNG를 갱신했다.

- 카드 없음. 패널 테두리/그림자 없이 평면 배경, 콘텐츠 폭 288px.
- 실제 폰트: CDP `CSS.getPlatformFontsForNode`가 custom `Inter Variable` / `InterVariable`로 확인. `login-platform-fonts-{light,dark}.json`.
- logo SVG 48×48, x776/y308. 그림 자체는 약42×42. 로고 아래 margin32px, 제목 y388.
- 제목18px/500, 실제 높이21px. 제목→폼24px. 버튼/입력288×44. 입력13px/400, padding12px, radius10px. 버튼13px/500, padding0 18px, radius9999px. 입력→버튼16px.
- 문서 배경 light #f8f8f9. dark는 html #09090a 위에 로그인 DIV가 실제 `linear-gradient(180deg,#111212 0%,#09090a 50%)`를 적용한다(아래 추가 측정 참조). 제목 light #2f2f31 / dark #e2e3e5.
- 입력 배경 light #f8f8f9 / dark #111212, 1px 경계 light #d2d2d2 / dark #27282a. 입력 텍스트 light #1b1b1b / dark #fff. placeholder #9c9c9e / #565658.
- 입력 focus outline 1px: light #6d78d5 / dark #5e69d1. blur 후 outline 없음. 기존 border는 동일.
- 이메일 계속 버튼 기본 및 입력채움: light #fefeff / dark #1b1b1c. hover #f3f3f3 / #242526. 텍스트 #2f2f31 / #e2e3e5.
- 버튼 외곽은 transparent1px border와 ::after shadow. 기본 light black alpha.10 0 0 0 1px, dark white alpha.09 0 0 0 1px. hover alpha.15 / .114. 부가 그림자는 JSON에 원문 보존.
- 빈 입력에서도 이메일 계속 버튼은 disabled=false였다. disabled 상태와 인증 실패/성공 상태는 관찰하지 않았다.
- 첫 로그인 방법 화면의 Google 버튼은 별도의 primary: light #6d78d5, dark 값은 `login-dark.json` 참조. Paper에 Google/SSO/passkey 기능을 추가하라는 근거가 아니다.
- root padding48px 0 88px, 내부 margin-top은 실제 matched CSS `max(0px,50svh - 240px)`다. fallback `max(0px,50vh - 240px)`도 확인했다. 1000px 높이에서는260px이다.

캡처: `login-{theme}.png`(로그인 방법), `login-email-{theme}.png`(빈 입력 focus), `login-email-ready-{theme}.png`(입력채움 기본), `login-email-hover-{theme}.png`, `login-email-blurred-{theme}.png`. 대응 JSON은 동일 파일명이다. 일부 최초 방법 화면에 공개 앱의 잠깐 나타난 Loading 문구가 body에 포함되지만 이메일 단계 완료 화면에는 없다.

Paper 대응 제안: 현재 계정명+발급 암호 인증 계약을 유지하면서 인증 전용 표면/288px 폭/18px 제목/44px 입력과 버튼/평면 구조에 위 실제 규칙을 적용한다. 인증용 pill 버튼은 첨부 앱의6px 공통 버튼을 덮어쓰는 근거로 쓰지 않는다. 인증 전 경로에서도 같은 Inter 자산이 실제 로딩되어야 한다.

## 앱 메뉴·속성·목록 — 실제 확인

URL: https://linear.app/demo/my-issues/assigned

- `team-menu-measured-{theme}.{png,json}`: 실제 Team menu. 팝업251×274, radius12, border1px. 행249×32, padding-left14/right18, 글꼴13px/400/line19.5. 구분선 섹션 간12px. 어두운 표면 computed `lch(12.72 0.85 272)`, 글자 `lch(91.178 1.425 272)`. 밝은 표면 `lch(100 0 282)`, 글자 `lch(20 1 282)`. CSS 값을 RGB 공식 토큰으로 재명명하지 않았다.
- 같은 `team-menu-measured` 화면에서 실제로 데이터가 있는 My issues 목록을 확인. issue anchor 행 높이44px, 반경8px, column-gap8px. wrapper의16px 폰트가 실제 자식 제목 글꼴이라는 뜻은 아니므로 제목폰트로 채택하지 않는다.
- `display-options-measured-{theme}.{png,json}`: 실제 속성 팝오버. List/Board 탭28px/12px500, gap6, pill. 속성 combobox120×24, font12px400, padding1px18px1px8px, radius8. 속성 badge24px/12px500. Settings 라벨/행의 직접 참조는 아니며 이 팝오버를 설정 화면이라고 부르지 않는다.
- `help-menu-light.{png,json}`: 실제 Help menu216×268/radius12, Settings 항목을 확인했다. 같은 dark Help 메뉴의 완료 캡처는 확보하지 못했다.
- `workspace-header-click-{theme}.{png,json}`: Linear Demo 텍스트 클릭으로 워크스페이스 전환 메뉴가 열리지 않았다. 워크스페이스 선택기라고 보고하지 않는다.

현재 공개 앱은 pill 버튼과32px 메뉴 행을 사용한다. 이전 첨부의6px 버튼·28px 메뉴 행과 빌드 차이가 있으며, 첨부 우선순위에 따라 기존 기준을 임의 교체하지 않는다. Paper 허브/자료/검사/설정의 정보 밀도와 라벨·컨트롤 정렬을 점검하는 보조 근거로 사용할 수 있다.

## 프로젝트 — 실제 확인

실제 sidebar 링크에서 확인한 URL https://linear.app/demo/projects/all 로 이동했다.

`projects-measured-{theme}.{png,json}`: 데이터가 로드된 프로젝트 타임라인. New project28px/12px500, Today/Year24px. 이는 프로젝트 표/카드 리스트 캡처가 아니므로 Paper 허브의 전체 형태가1:1이라고 판정하는 근거가 아니다. 프로젝트 속성 선택기는 추가 캡처 시도 중 네트워크 오류가 발생하여 확인하지 못했다. 이전 `public-create-issue-{theme}` 캡처는 기존 보고서에 유효한 근거로 남아 있어 반복 생성하지 않았다.

## 공개 접근으로 확인하지 못한 영역

- 실제 Help→Settings 클릭은 `https://linear.app/demo/agent`로 이동했다. `settings-from-menu-{theme}.{png,json}`가 이 결과를 보존한다.
- 추정 URL `/demo/settings/profile` 접근도 Agent 화면으로 이동했다. `settings-profile-route-{theme}`는 실패 경로 증거이며 프로필 화면 캡처가 아니다.
- 인증된 Settings/Profile/Appearance, 계정/워크스페이스 전환기는 보지 못했다. 공개 앱에서 도달하지 못하는 화면을 실제 측정했다고 보고하지 않는다.
- 마지막 보충 캡처에서 공개 데모가 Network error를 표시했다. 그 실패 화면은 `demo-network-error-light`로 구분했다. 성공적으로 확보한 파일의 측정은 유지하며 실패 화면을 디자인 근거로 쓰지 않는다.
- Paper의 PDF/소스 병렬 편집, 백업/복구, 규칙 적용, 리뷰번역/매핑에 직접 대응하는 Linear 화면은 없다. 확인한 공통 체계에 맞춘 제품 고유 구성이 필요하며 동일 콘텐츠 1:1은 성립하지 않는다.

관찰 범위 내 완성된 스크린샷/JSON을 전달하는 시점에서 참조 수집을 마친다. 공개 접근 실패를 반복 재시도하거나 계정·데이터를 생성하여 범위를 늘리지 않는다.

## 로그인 배경·세로 위치 추가 확인

`login-background-summary.json`과 `login-background-{theme}-{1600,390}.{png,json}` 및 `login-background-rules-*.json`은 html/body/#root, 전체 viewport 조상 및 ::before/::after, CDP matched CSS를 추가 확인한 결과다. 로그인만 열었고 폼을 전송하지 않았다.

- dark는 로그인 최상위 DIV의 실제 linear-gradient다. 별도 filter/pseudo/opacity overlay는 없다. source rule `.sx-1sny9ir`은 `linear-gradient(180deg,var(--sx-1ubxoo9) 0%,var(--sx-1m4y240) 50%)`, computed #111212→#09090a 50%다. 렌더 좌상단은 양 viewport에서 #101111, 중간/하단 #09090a였다. 초기 색상 요약의 dark 단색 설명을 이 관찰로 정정한다.
- `.sx-vfn2tk.sx-vfn2tk`의 `margin-top:max(0px,50svh - 240px)`와 이전 fallback50vh를 실제 CSS에서 확인했다. root padding-top48px+이 margin이 로고 y다.
- 390×844(양테마)에서는 콘텐츠288px/x51, logo48px/x171/y230, 제목y310/h21, 입력y355/h44. viewport만390px로 바꾼 DPR1 Chromium이며 모바일 UA/터치/키보드 높이는 모의하지 않았다.
