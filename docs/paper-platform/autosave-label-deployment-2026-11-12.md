# Response autosave footer label · 2026-11-12

하단 ‘Changes save automatically / 변경사항 자동 저장’ 안내 문구를 제거했다. 실제 공동 편집 저장·동기화, 글자/단어 수, 읽기 전용 및 연결 중 상태는 유지한다. 배포 이미지의 rebuttal.js는 이전 이미지에서 해당 문구 한 곳만 제거한 결과와 일치함을 확인했다.

Chromium·Firefox·WebKit의 기존 두 브라우저 간 답변 동기화·빈 답변 저장·새로고침 후 복원 검사 3개가 통과했다. 최신 운영 이미지에서 rebuttal.js와 rebuttal.html 캐시 키만 교체하고 정적 파일 69개 해시를 확인했다. 운영 파일·내부 HTTP·HTTPS 인증서·비로그인 401·서비스 상태는 비공개 릴리스 verification.json에 기록한다. 운영 계정 로그인 후 상호작용은 검사하지 않았으며 격리된 합성 데이터를 사용했다.

릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-autosave-label-hlmp9tfy/`
이미지: `sha256:7b86a10e4be5ec0dce9efda5dfce76afbd0d3889366c7d0a5b1890f8f3779270`
복구 설정: `runtime-previous/runtime.compose.json`.
검증: `.omx/artifacts/autosave-label-20261112-p6eas6yy/`.
