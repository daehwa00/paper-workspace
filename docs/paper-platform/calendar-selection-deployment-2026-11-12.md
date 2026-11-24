# Calendar selection contrast · 2026-11-12

선택 날짜를 흐린 회색 대신 채운 중립색으로 표시한다. 밝은 테마는 검정 배경에 밝은 숫자·점, 어두운 테마는 밝은 배경에 어두운 숫자·점으로 대비를 준다. 오늘 테두리와 빈 원·채운 원 마커도 선택 배경에 맞춰 반전한다. 기존 날짜 위치·크기·동작은 유지한다.

이미지 파일로 Chromium·Firefox·WebKit의 밝은·어두운 테마 정렬·선택 검사 6개가 통과했다. 두 테마에서 선택 배경·숫자·마커의 실제 계산 색상이 반전된 테마 색상과 같은지도 확인했다. 기존 호버 전환이 끝난 후 색상을 검사했다. 합성 화면을 기록했다.

최신 운영 이미지의 hub.css와 HTML 캐시 키만 교체했다. 정적 파일 69개 해시를 확인했다. 운영 파일·내부 HTTP·HTTPS 인증서·비로그인 401·서비스 상태는 비공개 릴리스 verification.json에 기록한다. 운영 계정 로그인 후 상호작용은 검사하지 않았으며 격리된 합성 데이터로 브라우저를 확인했다.

릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-calendar-selection-1wys31rs/`
이미지: `sha256:8e9ceb0b8b758e3f007cb2ab182a3f7999b97b3916d44f00604b1937d24b113a`
복구 설정: `runtime-previous/runtime.compose.json`.
검증·화면: `.omx/artifacts/calendar-selection-20261112-4cf1uc5v/`.
