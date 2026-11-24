# Compact hub activity timestamps · 2026-11-12

최근 작업 시각을 KST 기준으로 간단히 표시한다. 오늘은 방금·분 전·시간 전, 전날은 어제, 2~7일 전은 일 전으로 표시한다. 그 이전은 월·일만, 다른 연도는 한국어에서 YYYY.MM.DD로 표시한다. 미래 시각은 상대 시간으로 추정하지 않고 날짜로 표시한다. 한국어·영어를 지원한다.

정확한 날짜·시각은 time 요소의 title과 접근성 이름에 KST로 제공하고, datetime에는 원래 시각을 유지한다. 상대 시간은 1분마다 텍스트만 갱신해 부제목 편집 중에도 입력과 포커스를 보존한다.

최신 운영 이미지를 기준으로 hub.js와 hub.html의 자산 캐시 키만 변경했다. 다른 화면·서비스 변경을 보존했고, fuzz 없이 적용했다.

- 최종 배포 파일로 관련 브라우저 검사 52개 통과. 미국 시간대에서도 KST 날짜 경계·한영 표시·정확한 시각·편집 중 시간 갱신을 확인했다.
- 운영 파일 69개의 SHA-256 일치, 내부 HTTP 응답 일치, 실행 서비스 10개 정상.
- HTTPS 인증서 및 비로그인 401 확인. 호스트 DNS 제한으로 도메인을 로컬 Caddy 주소로 지정했다.
- 운영 계정의 실제 논문 변경은 수행하지 않았으며 저장 검사는 격리된 합성 데이터로 수행했다.
- 운영 이미지: `sha256:41b23e6b5dd7feb948348248a6ad5fb180a8023c8c3cddce13a4dfc4a7cc5579`
- 비공개 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-compact-activity-9sanazlh`
- 복구 설정: `/home/qlab/.local/state/paper-workspace/releases/20261112-compact-activity-9sanazlh/runtime-previous/runtime.compose.json`
