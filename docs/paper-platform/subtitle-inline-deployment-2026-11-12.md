# Hub subtitle inline editing · 2026-11-12

부제목은 제목(13px)보다 작은 11px로 표시하고, 마우스를 올리면 텍스트 커서를 표시한다. 클릭 시 별도 모달 없이 해당 위치에서 수정한다. Enter 또는 포커스를 다른 곳으로 옮기면 저장하고, Escape는 취소한다. 모바일 편집 입력은 자동 확대를 피하기 위해 16px, 높이 44px로 유지한다.

기존 메타데이터 API와 revision 충돌 방지, Undo, 읽기 전용 권한을 재사용한다. 저장 실패·충돌은 입력을 유지하고 Enter로 명시적으로 재시도한다. 한글 조합 중 Enter는 저장하지 않는다. 백그라운드 갱신은 입력을 교체하지 않으며, 다른 행이나 학회 버튼으로 이동하는 클릭도 유지한다. 페이지 이동 시 시작된 저장 요청은 keepalive로 전송한다.

## 배포 범위

진행 중이던 캘린더 배포가 먼저 완료되어 그 최신 운영 이미지를 기준으로 부제목 변경만 다시 적용했다. 다른 서비스와 캘린더 변경을 보존했고, hub.js·hub.css 및 자산 캐시 키를 변경한 hub.html만 교체했다. 패치는 fuzz 없이 적용했다.

- 운영 이미지: `sha256:6fe588bc46c0b6244e8dbd5b24e72b71083fd0a76327efb99b2e3dc21d47935a`
- 비공개 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-subtitle-inline-b6zz4ot_`
- 운영 설정: `/home/qlab/.local/state/paper-workspace/releases/20261112-subtitle-inline-b6zz4ot_/runtime-final/runtime.compose.json`
- 직전 버전 복구 설정: `/home/qlab/.local/state/paper-workspace/releases/20261112-subtitle-inline-b6zz4ot_/runtime-previous/runtime.compose.json`

## 검증

- 최종 이미지에서 추출한 파일로 메타데이터·목록·다국어·캘린더 검사 46개 통과.
- 이미지와 운영 정적 파일 69개의 SHA-256 일치.
- 내부 HTTP 자산 응답과 내용 일치, 실행 중인 서비스 10개 정상.
- 다른 서비스 컨테이너와 이미지 변경 없음.
- HTTPS 인증서 및 비로그인 401 응답 확인. 호스트 DNS 조회가 불가능해 도메인을 로컬 Caddy 주소로 지정했다.
- 운영 계정으로 로그인한 상호작용이나 실제 논문의 내용 변경은 수행하지 않았다. 저장 검사는 격리된 합성 데이터로 수행했다.
