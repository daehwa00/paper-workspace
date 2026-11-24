# Sidebar stability · 2026-11-11

이전 sidebar-motion 배포 후 검토에서 발견한 메모 패널 좌표와 취소 생명주기를 수정한다.

- Rebuttal은 #main, #mapping-workspace 내부의 본문 surface만 이동하며 fixed 메모·리사이저와 그 조상에 transform을 적용하지 않는다.
- 공통 취소 함수는 resize/storage/pagehide/비활성화/reduced-motion 변경, 리사이저 시작, Paper 초기화·도우미 변경, 리뷰 사이드바 상태 적용에 연결된다. 완료·취소된 Animation 객체는 정리한다.
- 리뷰 연결선·툴팁은 전환 중에만 숨기고, 완료·취소 후 최신 동작 세대가 최종 좌표로 다시 그려 표시한다.
- 실제 중간 프레임의 반전 연속성, 동작 줄이기에서 애니메이션 부재, 1000/1600px 열린 메모와 리사이저의 프레임별 좌표, 외부 이벤트 취소, 원고 선택 영역과 PDF 페이지/페이지 내 읽기 위치 유지까지 Chromium 고유 테스트 7개 통과. storage는 이벤트를 주입했고, viewport 변경과 리사이저 키보드 조작은 실제 브라우저 동작이다. 본문 너비 알림은 계속 토글당 1회다.

코드 검토 APPROVE, 아키텍처 CLEAR. 기존 통과 검사는 변경 영향이 있을 때만 재실행했다.

운영 이미지를 기준으로 bootstrap.js/app.js/rebuttal.js/rebuttal.css와 HTML 3개의 캐시 버전만 교체한다. 작업 폴더의 다른 미배포 변경과 별도 연구 체크아웃은 보존한다. 전체 정적 파일 68개 해시와 다른 서비스 이미지 불변을 확인했다.

비공개 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261111-sidebar-stability-fm5zzvru/`.
현재 고정 배포 설정은 `runtime-final/runtime.compose.json`, 이전 설정 경로는 `runtime-source.txt`, 검증은 `verification.json`, 변경은 `source-changes.patch`에 보관한다.
