# Opaque retained Rebuttal surface · 2026-11-12

리버탈 iframe이 기본 투명 배경을 사용하고, 활성 리버탈 뒤에도 원고 shell이 그대로 그려졌다. 리버탈 문서의 html과 고정 헤더도 투명해 알림으로 문서 높이가 바뀌거나 Safari 계열에서 스크롤할 때 뒤 화면이 노출될 여지가 있었다. 실제 사용자의 Safari 합성 현상 자체는 자동 환경에서 직접 재현하지 않았으나 해당 투명 경로를 제거했다.

- 리버탈 iframe·문서 canvas·고정 헤더에 불투명한 테마 배경을 적용한다.
- 리버탈 활성 중 뒤 원고 shell은 opacity=0으로 그리지 않는다. DOM과 공동 편집 세션은 유지하고 Paper로 전환하면 기존 원고와 상태를 그대로 복구한다.
- 문서 최소 높이를 viewport만큼 유지하고 세로 overscroll을 문서 안에 제한한다. 가로 브라우저 탐색 제스처는 제한하지 않는다.

## 검증

초기 후보에서 화면 전환·프레임 일치·원고 보존을 포함한 Chromium 검사 17개와 Firefox/WebKit 각 4개를 통과했다. 고정 헤더 배경을 추가한 최종 후보에서는 영향받는 알림/배경 검사 4개씩을 세 엔진에서 다시 통과했다(12개). 통과한 나머지 13개는 반복하지 않았다.

밝은·어두운 테마, 1440/390px 화면에서 긴 오류 알림 표시·스크롤·해제와 Paper 복귀를 확인했다. 뒤 원고에 선명한 자홍색 검사용 배경을 넣고 스크린샷에서 해당 색 픽셀이 0개임을 확인했다. 원고·답변 내용과 공동 편집 document ID가 유지됨을 확인했고, WebKit의 실제 알림 화면도 시각 확인했다. 운영 계정의 실제 내용은 수정하지 않았으며 합성 데이터로 검증했다.

## 배포

최신 운영 이미지에 app.css·rebuttal.css 및 두 HTML의 자산 캐시 키만 변경했다. fuzz 없이 적용하고 다른 변경은 보존했다. 정적 파일 69개 SHA-256과 내부 HTTP 내용이 일치하며 실행 서비스 10개 정상, 다른 서비스 컨테이너·이미지 변경 없음. HTTPS 인증서·비로그인 401은 호스트 DNS 제한으로 로컬 Caddy 주소를 지정해 확인했다.

- 이미지: `sha256:b6f18d9df4b6ad10a2fb29db3f0b201578d02cb943154ae36076e0de37c3822e`
- 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-review-surface-p_a14oc0`
- 복구 설정: `/home/qlab/.local/state/paper-workspace/releases/20261112-review-surface-p_a14oc0/runtime-previous/runtime.compose.json`
