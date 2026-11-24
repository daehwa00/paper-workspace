# 전체 회귀 검사 및 수정 · 2026-10-27

현재 작업 트리를 기준으로 CI의 브라우저·Python·협업/백업 단위 검사와 정적 검증을 실행하고 실패 원인을 수정했다. 실행 환경은 예제 원고, 격리된 개발 서버·SQLite/Yjs와 모의 API다.

## 수정한 실제 문제

| 영역 | 수정과 검증 |
| --- | --- |
| 태블릿 작업공간 탭 | 책갈피 형태의 탭이 터치 환경에서도 34px였던 문제를 공통 44px 타깃에 맞췄다. 터치에서는 음수 하단 여백을 없애 헤더 행 안에 전체 타깃이 들어가게 했다. |
| 리뷰 ↔ 원고의 언어 | 미리 로드한 두 뷰 사이를 전환할 때 현재 보이는 뷰의 언어를 다음 뷰에 전달한다. 원문·선택 위치를 보존하면서 한국어→영어 전환과 복귀를 검사한다. |
| 대화상자 포커스 복귀 | 가져오기 창이 열린 동안 비동기 재렌더링으로 원래 버튼이 교체되면 Escape 후 포커스가 사라졌다. 대화상자의 close 이벤트에서 살아 있는 트리거나 현재 대응 버튼으로 복귀한다. 실제 파일 선택을 포함한 양 테마·모바일/데스크톱 검사를 통과했다. |
| 모바일 리뷰 탐색 | 작은 화면에서 숨겨졌던 리뷰어·공통 답변 탐색을 높이가 제한된 가로 스크롤 행으로 제공한다. 긴 이름, 키보드 선택, 원고 유지, 44px 타깃과 넘침을 검사했다. |
| 미완료 가져오기·번역 | 리뷰 화면에서 미완료 항목의 파일명과 이어서 검토 동작을 노출하고, 고급 메뉴의 전체 리뷰 번역 편집 진입을 연결했다. 현재 연결 점검 도구의 배치와 명시적 AI 실행을 보존했다. |
| 개발 서버 캐시 키 | 공통 사이드바 스크립트의 해시 토큰을 개발 서버에도 등록해 실제 해시로 치환한다. 운영 템플릿과 동일하게 캐시 키 검사를 수행한다. |

작은 화면 추가 렌더링은 320·390px × 밝은·어두운 테마 **4조합**에서 확인했다. 리뷰어 탐색 행 높이 57px, 각 탐색/캐릭터 버튼 높이 44px, 문서 가로 넘침 0이다. 키보드 선택/재렌더링 뒤 공통 답변 버튼 전체가 보이는 것도 확인했다. [측정값](design-refresh/full-regression/mobile-metrics.json) · [밝은 탐색 영역](design-refresh/full-regression/mobile-navigation-light-320.png) · [어두운 탐색 영역](design-refresh/full-regression/mobile-navigation-dark-320.png).

## 테스트를 현재 계약에 맞춘 부분

- 정적 HTML 검사는 공통 `sidebar-account.js`에서 로드하는 실제 템플릿도 읽는다. 빠진 로더는 실패하도록 유지한다. 백업은 현재의 활동 행·연결선·낮은 강조의 작업 배치를 확인한다.
- 리뷰 검사는 활성 iframe과 실제 리뷰어/공통 답변 탐색을 사용한다. 숨겨진 문서·라운드 선택기를 참조하지 않고 라운드의 URL 문맥과 현재 탐색 동작을 확인한다. 삭제된 수동 캡처/확정 버튼을 찾던 시나리오는 저장된 다중 구절 연결의 보존·선택·오래됨과 명시적 재점검을 검증한다.
- 대비 검사는 실제 두 브라우저의 awareness를 사용한다. 직접 삽입한 가짜 peer가 동기화 중 사라지는 경합을 없앴고, 재렌더링 중 분리된 노드는 실제 연결된 요소로 다시 측정한다. 대비 4.5 기준은 유지한다.
- 메뉴의 검색→ArrowUp/Down→Escape 계약은 현재 공통 속성 메뉴에서 검증한다. 현재 사용하는 공통 계정 ID·배치·260ms 사이드바 전환을 반영했다.
- 모바일 크기 검사는 reduced-motion 조건에서 44px 타깃을 측정한다. 애니메이션 중 43.99998px로 읽힌 오차를 임계값 완화로 숨기지 않았다.

## 최종 결과

| 검사 | 결과 | 로그 |
| --- | --- | --- |
| 전체 Chromium 회귀 | **381 통과**, 실패·생략 0, 4.3분 | [전체 단일 실행](design-refresh/full-regression/browser-final.log) |
| Python 플랫폼 | **424 통과**, 실패·생략 0, 20.79초 | [전체 단일 실행](design-refresh/full-regression/python-final.log) |
| Node 협업·백업 | **41 통과**, 실패·생략 0 | [단위 검사](design-refresh/full-regression/node-final.log) |
| 합계 | **846 통과** | [구조화한 결과](design-refresh/full-regression/summary.json) |

정적 검사: JavaScript 구문, Python 컴파일, 두 클라이언트 번들의 재빌드 일치, Compose 구성 검증 통과. 번들은 임시 디렉터리에서 빌드해 기존 사용자 파일과 비교했다. 의존성 audit의 취약점은 0개다. 이번에 추가·수정한 줄의 공백 검사도 통과했다.

초기 전체 실행은 브라우저 **343 통과 / 38 실패**, Python **417 통과 / 7 실패**였다. 원인을 수정하며 영향받는 검사를 재실행했고, 중간 브라우저 전체 실행의 크기 측정 오류와 모바일 선택 항목 노출도 보완했다. 선택 항목 보완 후 [8조합 재검증](design-refresh/full-regression/mobile-selection-8.log)을 통과하고 마지막 전체 381개도 한 번에 통과했다. 최종 결과에 재시도·생략·예상 실패 처리를 추가하지 않았다. [최초 브라우저 로그](design-refresh/full-regression/browser-initial.log) · [최초 Python 로그](design-refresh/full-regression/python-initial.log) · [정적 검증](design-refresh/full-regression/static-verification.json) · [최종 소스 해시](design-refresh/full-regression/source-hashes.json).

재현 명령:

```sh
# 저장소 루트
python -m pytest -q tests/paper_platform
node --test apps/paper_workspace/collaboration/server.test.cjs apps/paper_workspace/collaboration/rebuttal-backup.test.cjs
# apps/paper_workspace/collaboration 디렉터리
PAPER_E2E_PORT=19250 CI=1 npx playwright test --workers=2 --reporter=line
```

CodeMirror 문서별 undo/redo, 선택·검색, Yjs 동기화·오프라인 복구, 컴파일·PDF·SyncTeX, 댓글·작업, 백업·복원, 리뷰 원문/번역·연결·규칙·제출/내보내기, 권한·프로필·테마·반응형을 현재 테스트 범위에서 검증했다. 외부 LLM·OpenReview 서비스와의 실계정 연동을 수행한 결과는 아니다.
