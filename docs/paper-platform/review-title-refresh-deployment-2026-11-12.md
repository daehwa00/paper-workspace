# Rebuttal refresh paper title · 2026-11-12

리버탈 직접 진입·새로고침에서 전체 원고 로딩을 생략하는 경로가 빈 제목 입력의 placeholder(논문 불러오는 중…)를 리버탈 제목으로 복사했다. 이 동작을 제거하고 프로젝트별로 확인된 제목 캐시를 유지한다. 캐시가 없으면 프로젝트 식별자를 임시로 표시한다.

직접 리버탈 진입 시 원고 복구 watchdog을 해제하고, manifest와 main.tex(없으면 entrypoint)만 읽어 Paper와 같은 방식으로 제목을 추출한다. 서버와 동기화된 files 맵의 현재 제목을 우선하고 이후 공유 제목 변경도 반영한다. 전체 원고 초기화·자산 로딩·PDF 컴파일·공유 원고 쓰기를 시작하지 않는다. 제목 조회 실패는 캐시를 보존하고 리버탈 사용을 막지 않는다. Paper로 전환한 뒤 확정된 제목은 늦은 리버탈 조회 결과보다 우선한다.

## 검증과 배포

- 최종 이미지에서 추출한 파일로 관련 검사 22개 통과: 직접 진입·새로고침·캐시·조회 실패·늦은 응답·공유 제목 우선순위·기존 Paper/Rebuttal 전환·원고 복구 watchdog 및 목록 회귀 검사.
- 기존 placeholder를 기대하던 두 검사는 로딩 안내 대신 프로젝트 식별자를 임시 표시하도록 갱신했다. 직접 진입 검사는 manifest/main만 조회하고 전체 원고는 Paper 전환까지 지연하는 조건으로 갱신했다.
- app.js와 index.html의 자산 캐시 키만 변경했다. 최신 운영 이미지 기준으로 다른 변경을 보존했고 fuzz 없이 적용했다.
- 운영 정적 파일 69개의 SHA-256, 내부 HTTP app.js/index.html 내용 일치. 실행 서비스 10개 정상, 다른 서비스 컨테이너·이미지 변경 없음.
- HTTPS 인증서·비로그인 401 확인. 호스트 DNS 제한으로 도메인을 로컬 Caddy 주소로 지정했다.
- 운영 계정으로 실제 원고를 수정하지 않았다. 브라우저 상호작용 검사는 격리된 합성 데이터로 수행했다.
- 이미지: `sha256:6f0c3a674bcf1de037cf03fa4394a6c310223563dfe0956712fe0141b380da54`
- 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-review-title-aa_rhi3o`
- 복구 설정: `/home/qlab/.local/state/paper-workspace/releases/20261112-review-title-aa_rhi3o/runtime-previous/runtime.compose.json`
