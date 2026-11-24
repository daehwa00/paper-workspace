# Sidebar snapshot transition · 2026-11-11

사용자가 transform 방식의 글줄 변경이 여전히 부자연스럽다고 알려 전환 방식을 변경했다. DOM 너비는 한 번 적용하지만, 브라우저의 이전 화면 이미지가 이동을 담당하므로 새 글줄 배치가 먼저 노출되지 않는다. 220ms 전환의 마지막 55ms만 새 화면으로 교체한다. 텍스트 이미지는 object-fit:none으로 글자 크기를 보존하고, PDF는 비율을 유지한다. 헤더 배경·제목·본문 패널·사이드바와 고정 메모는 독립된 이미지로 처리한다. 앱 페이지 간 이동 효과는 변경하지 않는다.

브라우저 동작 근거: [Document.startViewTransition](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition), [view-transition-old의 이미지 크기](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::view-transition-old). update 콜백은 동기식이다. 캡처 중 requestAnimationFrame을 기다리면 화면 갱신 중단으로 타임아웃이 발생하므로 기다리지 않는다. 해당 오류는 후보 검사 중 수정했으며 운영에 반영하지 않았다.

연속 클릭은 진행 중인 화면을 끊지 않고 순서대로 처리하며 남은 전환을 가속한다. resize/reset 등의 취소는 미실행 요청을 한 번 처리한 뒤 취소하지만, storage의 새 외부 설정은 대기 요청을 실행 없이 폐기하여 우선한다. 실패한 요청도 임시 이미지 이름과 숨김 클래스를 정리하고 오류를 보고한다. 모바일·동작 줄이기·API 미지원에서는 즉시 배치를 적용한다.

## 확인

- 단계별 합성 원고/PDF 화면을 캡처해 이동 중의 글자 크기와 프레임 경계를 확인했다. 원고를 새로 레이아웃하는 횟수는 여닫기당 1회로 유지된다. 실제 FPS 측정 주장은 하지 않는다.
- Chromium에서 연속 클릭, 열린 메모의 좌표, 편집 선택/PDF 읽기 위치, 외부 설정·resize·초기화·리사이저·동작 줄이기, API 미지원, 캡처 전 취소 및 예외 정리를 확인했다.
- Firefox/WebKit에서도 기본 전환·고정 메모·캡처 전 취소 검사가 통과했다. 병렬 실행에서 이전 전환이 끝나기 전 다음 검사를 시작하던 Chromium fixture는 idle을 기다리도록 수정하여 해당 검사만 재확인했다.
- 리뷰 startup의 마지막 renderAll이 의도적으로 동작을 취소하던 fixture는 실제 협업 준비 완료 뒤 검사하도록 조정했다. 운영 코드의 취소 규칙을 약화시키지 않았다.
- 코드 검토 APPROVE / 아키텍처 CLEAR. 기존 통과 검사는 독립된 영향이 없으면 반복하지 않았다.

운영 기준 bootstrap.js/rebuttal.js/project-frame.css와 HTML 3개 캐시 버전만 교체했다. 정적 파일 68개의 해시와 다른 서비스 이미지 불변을 확인한다. 작업 폴더의 기존 미배포 변경은 별도 패치로 보존했다.

비공개 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261111-sidebar-snapshot-6j6va31c/`.
`runtime-final/runtime.compose.json`이 현재 고정 설정이다. `runtime-source.txt`에 이전 설정 경로, `verification.json`에 확인 결과, `source-changes.patch`와 `runtime-changes.patch`에 변경을 보관한다. frames/는 합성 예제만 포함한다.
