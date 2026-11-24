# Sidebar motion · 2026-11-11

Paper와 Rebuttal의 사이드바 전환에서 width/margin 보간을 제거하고, 최종 레이아웃을 한 번 적용한 뒤 본문·모드 탭·헤더 배경을 180ms transform으로 이동한다. 빠른 재클릭은 현재 시각 위치에서 다시 시작하고 이전 애니메이션을 취소한다. 모바일과 reduced-motion 설정에서는 즉시 전환한다.

운영 이미지에서 추출한 파일로 같은 Chromium 테스트를 수행했다. 본문 ResizeObserver 알림은 닫기/열기 기준 Paper 15/16회, Rebuttal 15/15회에서 각각 1/1회로 감소했다. FPS 측정치는 아니다. 최종 테스트 3개는 두 화면의 반복 전환·reduced-motion·접근성 상태와 PDF 페이지 크기 일관성을 검증한다.

운영 정적 파일과 작업 폴더에는 다른 변경사항이 존재하여, 운영 파일에 이번 패치만 적용했다. bootstrap.js, app.js, rebuttal.js, project-frame.css와 HTML 세 파일의 캐시 키만 교체했다. 정적 파일 68개의 해시를 확인했고 다른 서비스 이미지는 그대로 유지했다. 공개 저장소 작업 폴더에도 같은 수정만 적용했으며 기존 미커밋 변경을 포함한 커밋은 만들지 않았다. 예전 연구 체크아웃은 구조가 달라 전체 파일 복사로 덮어쓰지 않았다.

비공개 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261111-sidebar-motion-nbnxynzq/`.
`runtime-final/runtime.compose.json`은 현재 고정 배포 설정이다. `runtime-source.txt`가 가리키는 이전 설정으로 화면 서비스만 복구할 수 있다. source-changes.patch에 작업 폴더 기준 변경, verification.json에 확인 결과를 보관한다.
