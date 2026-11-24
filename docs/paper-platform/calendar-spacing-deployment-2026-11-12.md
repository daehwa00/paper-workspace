# Calendar card spacing · 2026-11-12

카드의 ‘제출 마감 / KST’ 제목 줄을 제거했다. 제출 마감 목록과 각 시각의 접근성 이름에는 KST를 유지하며 실제 시간 변환은 바꾸지 않는다.

카드 내부 자간을 .015em, 기본 행간을 1.7로 맞췄다. 분야 설명, 개최 정보, 제출 행, 안내 문구와 공식 링크 사이 간격을 넓혔다. 마감 행의 내부 여백은 9px/8px, 날짜와 시각 사이 간격은 10px, 공식 링크 간격은 24px이다. 여러 학회의 구분선 위아래에도 여백을 더했다. 기존 카드 폭·크기와 캘린더 오른쪽 배치를 유지한다.

최종 이미지의 파일로 Chromium·Firefox·WebKit 검사 12개가 통과했다. 밝은·어두운 테마, 짧은 화면, 화면·사이드바 너비 조합에서 카드 크기·경계·위치를 확인했고, 제목 줄 제거와 접근성 시간대·학회 상세 내용·링크도 확인했다. 합성 화면을 검토했다.

최신 운영 이미지에 hub.css·hub.js와 HTML 캐시 키 변경만 적용해 다른 변경을 보존했다. 정적 파일 69개의 해시를 확인했다. 운영 파일·내부 HTTP·HTTPS 인증서·비로그인 401 및 서비스 상태는 비공개 릴리스 verification.json에 기록한다. 운영 계정으로 로그인한 상호작용은 검사하지 않았다.

릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-calendar-spacing-n61dheu0/`
이미지: `sha256:434e462934153b6a94f74612534223ea7b86619f45b7058ecfea140d5fda24cd`
복구 설정: `runtime-previous/runtime.compose.json`.
검증·화면: `.omx/artifacts/calendar-spacing-20261112-df0ek5l0/`.
