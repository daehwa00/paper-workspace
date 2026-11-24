# Sidebar animation performance · 2026-11-11

운영 화면 서비스에 사이드바 접기·펼치기 최적화를 배포했다. 스냅샷의 너비·높이 보간을 고정 크기 캔버스의 이동·클리핑으로 바꾸고, 글자가 없는 헤더 배경만 확대·축소한다. 중복된 전체 화면 캡처와 사이드바 내부의 크기 전환을 제거한다. 기존 220ms 전환, 글자 크기, 고정 메모, 연속 클릭과 취소 동작은 유지한다.

배포 직전의 프로젝트 메타데이터 릴리스 `runtime-final-v2` 이미지를 기준으로 이번 패치만 적용했다. `bootstrap.js`, `project-frame.css`, HTML 3개의 캐시 버전만 교체했다. 작업 폴더의 다른 미배포 변경과 다른 서비스는 보존했다.

검증 결과:

- 배포 이미지에서 추출한 파일로 사이드바·PDF 브라우저 검사 13개 통과.
- 이미지 및 실행 중인 컨테이너의 정적 파일 68개 SHA-256 일치.
- Caddy 컨테이너에서 화면 서비스로 요청한 변경 자산·HTML 5개의 응답 해시 일치.
- 실행 중인 10개 서비스 모두 healthy. 화면 서비스 이외의 컨테이너와 이미지 불변.
- HTTPS 인증서 검증과 비로그인 요청의 401 응답 확인. 호스트 DNS 조회가 실패하여 도메인을 로컬 Caddy 주소에 지정했다. 외부 단말의 전체 접속 경로와 운영 계정으로 로그인한 상호작용은 검사하지 않았다. 상호작용 검사는 동일한 배포 파일과 격리된 합성 데이터로 수행했다.

비공개 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261111-sidebar-performance-rynns3h9/`.
현재 고정 설정은 `runtime-final/runtime.compose.json`, 화면 서비스 복구용 이전 설정은 `runtime-previous/runtime.compose.json`이다. `verification.json`에 배포 확인 결과, `source-verification.json`에 이전 로컬 성능 측정과 검사 결과, `runtime-changes.patch`에 이번 정적 파일 변경을 보관한다. 복구 시 이전 설정으로 `workspace`만 `--no-deps --no-build --pull never` 옵션으로 교체한다.
