# Review sidebar arrow visibility · 2026-11-12

리뷰 화면의 데스크톱 헤더 배경이 사이드바 첫 행을 덮어 접기 화살표와 제목이 보이지 않았다. 버튼·SVG의 계산된 색상과 표시 상태는 정상이었지만 실제 캡처에는 배경색만 그려졌다. rebuttal.css의 더 구체적인 헤더 배경 규칙을 데스크톱 project-frame 규칙에서 투명하게 덮어써 가림을 제거했다. 모바일의 불투명 헤더는 유지한다. 버튼 색상·위치·사이드바 애니메이션은 바꾸지 않았다.

검증:
- 최종 이미지 파일로 Chromium·Firefox·WebKit 검사 12개 통과.
- 밝은·어두운 테마의 펼친/접힌 상태에서 실제 SVG 영역 캡처를 브라우저 캔버스로 읽어 화살표 픽셀이 배경과 구분되는지 확인했다. CSS 계산 상태만 확인하면 놓치는 회귀를 방지한다.
- 모바일 헤더 배경 유지, 기존 접기·펼치기·진행 중 반전·모션 감소 검사가 통과했다. 본문 레이아웃 변경은 각 방향에서 1회였다.
- 최신 운영 이미지에서 project-frame.css와 index.html·rebuttal.html 캐시 키만 갱신했다. 이미지 정적 파일 69개 해시를 확인했다. 운영 파일·내부 HTTP·HTTPS 인증서·비로그인 401·서비스 상태는 비공개 릴리스 verification.json에 기록한다.
- 운영 로그인 후 상호작용은 검사하지 않았다. 브라우저 검사는 격리된 합성 데이터를 사용했다.

릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-sidebar-arrow-yp7ckmdj/`
이미지: `sha256:0545953ab956373bb766fbf231e16e0626386c6ae283e3da031a5f6592d3b041`
복구 설정: `runtime-previous/runtime.compose.json`.
검증·화면: `.omx/artifacts/sidebar-arrow-20261112-npvsniun/`.
