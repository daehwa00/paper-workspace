# Response character counter · 2026-11-12

답변 하단의 글자 수를 오른쪽으로 정렬하고 단어 수 표시는 제거했다. 한국어는 ‘123자’, 영어는 ‘123 characters’ 형식이다. 기존 문자 수 계산, 분량 제한의 단어 수 검사, 저장 기능 및 읽기 전용·연결 상태는 유지한다.

최종 이미지 파일로 Chromium·Firefox·WebKit의 편집·미리보기 검사 3개가 통과했다. 입력 후 정확한 글자 수만 표시되는지, 카운터가 오른쪽 18px 여백 안에 정렬되는지, 미리보기 전환 후 원문이 보존되는지 확인했다. 실제 운영 JS에는 카운터 표현식만 교체했고 CSS에는 해당 카운터 정렬 규칙만 추가했다.

최신 운영 이미지에서 rebuttal.js·rebuttal.css·rebuttal.html 캐시 키를 갱신했다. 이미지 파일 69개 해시를 확인했다. 운영 파일·내부 HTTP·HTTPS 인증서·비로그인 401·서비스 상태는 비공개 릴리스 verification.json에 기록한다. 운영 로그인 후 직접 상호작용은 검사하지 않았으며 브라우저 검사는 격리된 합성 데이터를 사용했다.

릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-character-count-e93ks5zu/`
이미지: `sha256:ec901a941e013bb4d4a99511ca7b80006951f25b1879491206c548bd6bcbb880`
복구 설정: `runtime-previous/runtime.compose.json`.
검증: `.omx/artifacts/character-count-20261112-ew8c8v_s/`.
