# Calendar card placement · 2026-11-12

학회 상세 카드의 가로 기준을 클릭한 날짜 셀에서 전체 사이드바 오른쪽 경계로 바꿨다. 카드 왼쪽을 사이드바 오른쪽에서 12px 떨어뜨려 캘린더를 가리지 않는다. 세로 위치는 클릭한 날짜·마감 행을 따르되 화면 위아래 경계에 맞춘다. 카드 폭은 오른쪽 남은 공간 안으로 제한한다.

최종 이미지 파일로 Chromium·Firefox·WebKit 검사 9개를 통과했다. 768/1024/1440px 화면과 180/244/320px 사이드바 조합에서 카드·캘린더 겹침이 없고 카드 전체가 화면 안에 있는지 확인했다. 기존 밝은·어두운 테마의 카드 크기와 제목 글자 크기도 확인했다.

최신 운영 이미지의 hub.js와 HTML 캐시 키만 변경했다. 다른 동시 변경은 보존했다. 정적 파일 69개 해시, 배포 후 내부 HTTP 자산·HTTPS 인증서·비로그인 401 및 서비스 상태는 비공개 릴리스 verification.json에 기록한다. 브라우저 검사는 격리된 합성 데이터를 사용했으며 운영 계정 로그인 후 상호작용은 검사하지 않았다.

릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-calendar-placement-i9x593lu/`
이미지: `sha256:257abbf7077b37198c8bf46bb589df0d3c0a6c039f3d7a76f89ba2722d816704`
복구 설정: `runtime-previous/runtime.compose.json`.
검증·화면: `.omx/artifacts/calendar-placement-20261112-2o7um7av/`.
