# Linear 전면 개편 목표의 완료 감사

2026-10-27 갱신. 기준은 사용자 `goal-objective.md` 전체다. 파일을 읽었다는 사실이나 일부 검사가 통과했다는 사실을 전체 목표 달성으로 대신하지 않는다. 이전 목표 실행은 소스 수정과 재현 검사·실제 캡처를 남겼으므로 **진행(progress)** 으로 분류한다.

**전체 완료는 아직 증명되지 않았다.** 공통 체계와 기능 회귀의 근거는 있지만, 첨부의 원래 viewport/DPR/zoom과 동일 버전 상태 화면이 없어 요구된 동일 배율의 1:1 검증을 할 수 없다. 10월 26일 통합 검증은 [정밀 보정 보고서](linear-precision-2026-10-26.md)에 마무리되었다. 이후 실제 공개 앱을 추가 확보해 [프레임 보정과 48개 화면 검증](linear-live-frame-2026-10-27.md)을 수행했다. 과거의 접속 실패나 진행 중 상태를 현재의 사실로 남기지 않는다. 아래에서 “근거 있음”은 명시된 범위의 증거를 뜻하며 무제한 보증이 아니다.

추가 공개 자료도 확인했다. [Linear 공식 시작 가이드](https://linear.app/docs/start-guide)는 가입 전 [데모 작업공간](https://linear.app/demo)을 제공한다. 초기 Chromium 접속은 CDN 자산 connection reset으로 실패했다([초기 오류 캡처](design-refresh/frame-ownership/demo-network-error.png), [진단](design-refresh/frame-ownership/demo-network-diagnostic.json)). 이후 공개 자산을 HTTP Range로 읽고 바이트 범위·전체 길이를 검증해 브라우저에 같은 자산을 전달하자 **실제 데모 앱 렌더에 성공했다**. 1600×1000/DPR1, fonts loaded인 최초 앱 화면은 `.omx/artifacts/linear-live-reference/demo-range.png`와 JSON에 보존했다. 앱 코드·CSS를 합성하지 않았고 로그인·계정 생성·문서 수정·메시지 전송은 하지 않았다. 현재 공개 빌드의 밝음/어두움 실제 프레임을 측정하고 대응 crop을 비교했다([후속 결과](linear-live-frame-2026-10-27.md)). 첨부와 단일 빌드임을 입증한 것은 아니다. 따라서 “공개 데모에 접근하지 못했다”는 초기 결과는 현재의 차단 근거가 아니다.

공식 CDN의 현재 `InterVariable.woff2`와 제품에 포함된 `inter-variable.woff2`는 SHA-256 `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`로 바이트가 같다. [검증 JSON](design-refresh/frame-ownership/inter-asset-equivalence.json). 따라서 **현재 공개 폰트 파일 자체**의 차이는 배제할 수 있다. 첨부 화면 모두가 그 파일을 썼는지, CSS 크기·굵기·행간·letter spacing과 한국어 fallback까지 같은지는 별도 문제다.

## 컴포넌트 구성 보완 — 2026-10-27

사용자가 지적한 기존 배치 위의 세부 스타일 보정 한계를 인정하고 구조를 재구현했다. 프로젝트 선택기, 위치/뷰 바, 실제 속성 메뉴, 프로젝트 목록, 리뷰 문서 pane, 댓글 activity와 초기/후속 하단 composer의 대응 구조·동작을 수정했다. [새 전후·구현·검증 보고서](linear-components-rebuild-2026-10-27.md)가 이 영역의 최신 근거다. 아래 과거 상태 기록과 단일 빌드 픽셀 동일성의 한계는 실제 구현 진척과 구분한다.

## 요구사항별 근거와 남은 일

| 목표 항목 | 확인한 현재 근거 | 판정 |
| --- | --- | --- |
| 1. 실제 앱 UI 우선, 기준 버전 고정 | 첨부 01 오른쪽 sidebar·02 아래 tabs의 2026-03-12 디자인 계열을 주 기준으로 고정. 04/13/18/19는 같은 해의 보조 자료, 날짜 미상 문서는 구조 참고, 20은 2024로 분리. [원본 20개 무결성](design-refresh/frame-ownership/reference-integrity.json), [추출 문서](linear-reference-2026.md). | 기준·출처 근거 있음. 단일 앱 빌드와 원본 CSS 배율은 미확인. |
| 2. 프로젝트·원고 데이터 보존 | `app.js`, `workspace-core.js`, `workspace-storage.js`; 파일 충돌·외부 변경·복원 경쟁과 초기 협업 상태의 실제 브라우저 assertions가 있는 `state-integrity.spec.js`, `workspace.spec.js`. [독립 기능 120개](design-refresh/goal-validation/functional-120.log). | 회귀 근거 있음. 이번 디자인 수정은 저장 데이터 migration을 수행하지 않음. |
| 2. 계정·프로젝트 접근 권한 | `password_gate/{accounts,server}.py`, `collaboration/server.cjs`, Rebuttal server 권한 경계. `test_personal_accounts.py`, `test_password_gate.py`, server tests 및 Rebuttal viewer 검사가 존재. [기존 실행 범위](linear-reference-implementation.md). | 근거 있음. 운영 계정 실접속 검증은 수행하지 않음. |
| 2. API·저장 형식 호환 | 서버·백업 계약 tests, legacy Rebuttal backup compatibility와 viewer 경계. 디자인 관련 CSS/HTML과 프로젝트 탐색 링크의 언어 전달을 수정하며 데이터·API 형식은 유지. | 기능 모의 대체 없음. 기존 기능 보고서의 범위를 넘는 보장은 하지 않음. |
| 2. CodeMirror 선택·undo/redo | 파일별 편집 기록, 외부 변경 후 history와 키보드·마우스 선택 검사. [편집/상호작용 로그](design-refresh/goal-validation/editor-interaction-10.log). | 명시한 회귀 범위 통과. |
| 2. Yjs 공동편집·오프라인 복구 | 두 독립 브라우저 동기화, IndexedDB 불가 시 bounded recovery, pagehide 복구, 재연결과 초기 bootstrap 보존 assertions. `workspace.spec.js`, `rebuttal.spec.js`, 협업 server tests. | 근거 있음. 운영 네트워크 장애의 전체 조합을 실험한 것은 아님. |
| 2. 컴파일·PDF·SyncTeX | 브라우저 컴파일 최신성/취소/캐시/뷰어 테스트와 [실제 TeX+양방향 SyncTeX 2개](design-refresh/frame-ownership/real-synctex.log). PDF 캡처는 기존 실제 컴파일 결과를 사용한 기록이 있음. | 근거 있음. 10월 26일 통합 검사와 실제 PDF 캔버스 캡처에서 확인. 운영 컴파일 서비스 전체 부하 검증은 별도다. |
| 2. 댓글·작업·Codex 제안 | `app.js` 실제 handlers 유지. 댓글 생성, 작업·복원, 제안 유지/명시적 적용과 취소 assertions. [미리보기 대비/입력 회귀](design-refresh/goal-validation/targeted-6.log). | 근거 있음. 테스트의 Codex 응답만 모의 처리. |
| 2. 리뷰 번역·다대다 매핑·분석 최신성 | `rebuttal.js`, `rebuttal-model.js`, Rebuttal service. `rebuttal.spec.js`의 여러 구절 매핑·결정·늦은 분석 stale·문서 경계와 translation assertions. | 기능 근거 있음. 새 선택 메뉴·긴 문구는 통합 보고서에 확인되었고, 이후 프레임 48조합도 검증했다. |
| 2. 규칙 초안 확인·명시적 적용 | staged import/rules apply, diff review, official rules draft와 rewrite explicit application 테스트. 편집과 적용 단계를 유지. | 근거 있음. |
| 2. 분석 동작에만 LLM 호출 | 클릭 전 0회·명시적 실행 후 1회, 입력 취소 0회 assertions. 일반 편집의 최신성 갱신은 분석을 시작하지 않음. | 테스트 fixture 범위에서 통과. 외부 유료 LLM 실호출 없음. |
| 2. 백업·복원·내보내기 | 파일·댓글·작업의 원자적 복원, 편집 중 복원 중단, ZIP과 submission export, legacy 백업 계약 검사. | 기능 근거 있음. 운영 저장소 복원은 실행하지 않음. |
| 3. 13개 디자인 추출 항목 | `linear-reference-2026.md`가 표면/텍스트/폰트/버튼/아이콘/탐색/헤더/탭/메뉴/경계/상태/전환·reduced-motion을 표로 구분. `theme.css` 토큰과 `DESIGN.md`에 적용. | 문서화·공통 구현 근거 있음. 공개 앱 프레임의 CSS px와 현재 Inter 파일 일치는 확인했다. 첨부의 빌드·배율과 미확인 light/state 값은 별도 한계다. |
| 4. 주/보조/quiet/icon/danger 버튼·그룹 | `theme.css`의 variant/state, 기본 28px·touch 44px 체계, primary 실제 pointer hover/active 대비와 quiet hit target 검사. | 구현 근거 있음. Linear의 각 상호작용 상태 원본은 미확인. |
| 4. 탭·선택 메뉴·검색·입력 | 공통 theme, native select picker의 지원 엔진 향상/fallback, ARIA 탭과 실제 키보드 순서, 입력 대비·취소 검사. | 구현·접근성·긴 선택 문구 근거 있음. 한국어 프로젝트 왕복 시 언어 유실도 수정·검증했다. |
| 4. 체크박스·라디오·toggle·배지 | 공통 checked/indeterminate/disabled/focus, 실제 profile/theme/task/rules 입력, pressed/selected state. 실제 boolean 설정은 `role=switch`의 26×16px 트랙/12px 손잡이로 구성하고 다중 선택은 사각 checkbox를 유지함. | 기존 컨트롤의 공통화 근거 있음. |
| 4. tooltip/popover/context menu/dialog/toast | 공통 overlay, Escape·메뉴 탐색·trigger 복귀, dialog 명명, [새 접근성 5개 포함 23개](design-refresh/frame-ownership/a11y-after.log), 모바일 입력 위로 알림 배치. | 검사한 상호작용 근거 있음. 동일 버전 Linear open 상태의 정밀 비교 미확인. |
| 4. 목록·loading·empty·readonly | 선택/hover 역할 분리, native disabled/readonly, `aria-busy`와 기존 spinner, 빈/오류/연결 상태 유지. viewer 실제 검사 존재. | 구현 근거 있음. 모든 상태의 Linear 원본 대응은 없음. |
| 5. 로그인·허브 | 공유 theme와 layout-only login, hub list/rail/검색/프로필. 기존 실제 light/dark 로그인·허브 이미지와 로그인 검사. | 적용 근거 있음. 2026 Linear 로그인 원본 없음. |
| 5. 원고·파일·소스/PDF·도우미 5탭 | 현재 HTML/JS와 공통 프레임, 기능 assertions 및 여러 viewport의 실제 캡처. PDF 자체 표현은 테마에서 제외. | 적용·회귀 근거 있음. 현재 공개 앱과 1600×1000/DPR1 대응 crop 비교도 추가했다. 첨부 원본과 같은 빌드의 동일 배율 입증은 별도다. |
| 5. Rebuttal 4화면·규칙·설정·백업/내보내기 | 실제 routes/handlers, 96조합 기존 화면 검사, native modal과 새 accessible names. | 적용 근거 있음. 최신 프레임 변경 후 추가 48화면과 관련 브라우저 검사를 통과했다. |
| 5. 밝음·어두움 | 단일 토큰 체계, DOM 테마 변경과 실제 스크린샷. [선택 입력 32조합](design-refresh/goal-validation/selection-summary.json). | 양 테마 구현 근거 있음. 현재 공개 앱 light frame은 확보했으며 첨부 기준과 같은 빌드임은 미입증. |
| 6. 기존 stack·DOM/CSS·사용자 변경 보존 | vanilla HTML/CSS/JS, CodeMirror/Yjs/PDF.js 유지. 이미지로 UI를 대체하지 않음. 미커밋 파일 보존, 별도 검증 서버·복사본 사용. | 근거 있음. |
| 6. 공통 책임과 override 정리 | `theme.css` 공통 컨트롤, `project-frame.css` 원고/Rebuttal 프레임. 원고의 중복 header/tab/frame/rail CSS 제거. [24상태 정리 전후 차이 0](design-refresh/frame-ownership/settled-differences.json), [탐색·전환 13개](design-refresh/frame-ownership/regressions.log), [Python UI 69개](design-refresh/frame-ownership/platform-ui.log). | 이번 변경의 책임 분리·동작 보존 근거 있음. |
| 7. 조사→추출→공통 구현→대표 화면→전체 적용→검증 | 추출 문서·초기 캡처·구현 기록·현재 결과 파일에 단계별 근거가 있음. 기존의 현재 외형 유지 제한은 새 목표로 대체. | 조사·실제 구현·회귀·캡처와 후속 보정 기록이 있다. 단일 빌드 1:1 완료 판정은 별도다. |
| 8. 동일 viewport/배율/테마의 Linear 비교 | 공개 Linear와 Paper를 1600×1000·DPR1·scale1·fonts ready·motion 통제로 직접 캡처했다. 첨부에는 CSS viewport/DPR/zoom이 없고 이미지마다 확대·암전/편집이 있다. | **공개 앱 프레임의 동일 배율 비교는 수행. 첨부와 같은 빌드임은 미입증.** 정규화 첨부 crop과 직접 캡처의 비교를 구분한다. |
| 8. 대응 crop·제품 내용 차이 분리 | 선택 탭/원본 crop과 색상 진단, 제품 문구·로고·PDF/분할 영역을 구분한 보고서. 전체 페이지 픽셀 차이를 유사도 점수로 쓰지 않음. | 근거 있음. 모든 지정 컴포넌트의 동일 상태 대응 원본은 부족. |
| 8. 320/390/1024/1600·긴 한/영·키보드/대비 | 공통 화면·Rebuttal·선택 툴바 조합, 실제 키보드·메뉴/폼 포커스와 대비 검사. 새 선택 메뉴 회귀는 통합 보고서에 수정·검증 기록이 있다. 후속 48화면은 실제 HTML 언어도 확인했다. | 문서화한 화면·상태·fixture 범위에서 통과. 운영 전체나 미확인 원본 상태까지 확장하지 않는다. |
| 9. 설명되지 않은 시각 차이 없는 거의 1:1 결과 | 원본 CSS px·폰트 버전·전체 light/open/interacting 상태·단일 build 대응이 확인되지 않음. | **미달. 추정치나 녹색 검사 수로 대신할 수 없음.** |
| 9. 전후 이미지와 검증 결과 | [기존 전후/컴포넌트 보고서](linear-reference-implementation.md), [독립 추가 검증·실제 전후](linear-goal-validation.md), 각 로그/JSON/PNG. | 결과물 존재. 전체 달성 선언의 충분조건은 아님. |

## 1:1 완료 판정에 필요한 최소 추가 자료

1. 첨부 기준과 같은 빌드임을 확인할 수 있는 전체 앱 프레임을 밝음·어두움으로 각각 캡처한 원본. 현재 공개 데모의 양 테마 원본과 배율은 이미 확보했지만 같은 빌드임은 입증하지 못했다. 상단 탭·사이드바·목록/상세 영역이 함께 보여야 한다.
2. 같은 빌드에서 열린 프로젝트 선택기/속성 메뉴, 확인 대화상자, 댓글 영역, 버튼 hover/focus/disabled/loading 상태의 원본.
3. 각 캡처의 CSS viewport 너비×높이, `devicePixelRatio`, 브라우저 zoom과 font 로딩 완료 여부. 래스터 파일 해상도만으로 이 값을 추정하지 않는다.

제품 고유의 논문/PDF 분할, 원고 내용, 로고·문구, 리뷰 근거 매핑과 모바일 44px 타깃은 의도된 차이로 따로 비교한다. 자료가 없는 상태를 봤다고 주장하거나 설명되지 않은 차이를 임의 점수로 덮지 않는다.
