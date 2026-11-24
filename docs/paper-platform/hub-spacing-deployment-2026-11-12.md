# Compact hub metadata spacing · 2026-11-12

메인 논문 목록의 오른쪽 정보를 같은 너비의 열로 모았다. 작성자 32px·날짜 88px, 학회 108px·페이지 32px에 각 내부 간격 8px을 적용한다. 두 묶음 사이는 데스크톱 20px, 태블릿 12px이다. 넓은 화면의 오른쪽 영역은 기존 416px에서 296px로 줄여 제목 영역을 확보했다. 검색의 시작선과 작성자 열, 정렬의 끝선과 페이지 열을 맞췄다. 작은 목록의 기존 세로 배치는 유지하고 긴 정렬 이름이 열을 넘지 않도록 제한했다.

최신 운영 이미지를 기준으로 hub.css와 hub.html의 캐시 키만 교체했다. 준비 중 다른 화면 배포가 반영되어 최신 이미지로 다시 구성했으며 다른 변경은 보존했다. 패치는 fuzz 없이 적용했다.

- 최종 이미지 파일로 관련 브라우저 검사 56개 통과.
- 새 간격 검사는 밝은·어두운 테마, 2155/1644/1024/900/768/390px 너비, 열 정렬·간격·가로 넘침·한영 정렬 컨트롤을 확인했다.
- 합성 화면을 직접 확인했다. 운영 계정의 실제 논문 수정은 수행하지 않았다.
- 정적 파일 69개의 SHA-256과 내부 HTTP 내용 일치, 실행 서비스 10개 정상. 다른 서비스 컨테이너·이미지 변경 없음.
- HTTPS 인증서와 비로그인 401 응답 확인. 호스트 DNS 제한으로 도메인을 로컬 Caddy 주소로 지정했다.
- 운영 이미지: `sha256:c4f0d0eac0df9e87fb0c2b2a6776242d4fdb468efbb3c33ea358c691ecd0c467`
- 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-hub-spacing-d3kir5tn`
- 복구 설정: `/home/qlab/.local/state/paper-workspace/releases/20261112-hub-spacing-d3kir5tn/runtime-previous/runtime.compose.json`
