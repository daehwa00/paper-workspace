# Stable project previews during hub updates · 2026-11-12

활동 기록과 페이지 수를 갱신할 때 목록 전체 innerHTML을 교체하면서 동일한 미리보기 이미지를 다시 생성했다. 페이지 수 조회 전후로 두 번 렌더링하고, 창 포커스·탭 복귀·정렬·한영 전환에서도 같은 경로를 거쳐 그림이 깜빡일 수 있었다.

프로젝트 slug로 행을 재사용하고, 같은 thumbnail URL은 디코딩된 이미지 노드를 보존한다. 변경된 제목·활동·학회·페이지 영역만 갱신하고 정렬 시 기존 행을 이동한다. 이미지 오류의 기존 대체 아이콘도 유지한다. 새 행은 inert template에서 파싱해 실제로 삽입할 이미지 외에 불필요한 요청이 발생하지 않게 했다. 이미지 오류 처리는 WeakSet으로 중복 등록을 막았다. 이미지 URL이 바뀌면 해당 논문의 미리보기만 교체한다. 동일 URL의 미리보기 내용 변경이나 누락 파일 복구는 페이지 재진입·새로고침 또는 URL 변경 시 반영된다.

## 검증과 배포

- 최종 이미지 파일로 Chromium 관련 검사 60개, Firefox 미리보기 검사 3개, WebKit 미리보기 검사 3개 통과: 총 66개.
- 이미지 응답을 no-store로 설정하고 활동·페이지 수·제목 갱신 중 원래 이미지 노드·디코딩 상태·로드 횟수·네트워크 요청 수가 유지됨을 확인했다.
- 정렬·한영 전환 후 이미지 보존, URL 변경 시 해당 이미지 교체, 누락된 이미지의 반복 요청 억제를 세 브라우저에서 확인했다.
- 메타데이터 저장·충돌·Undo·초안 보존, 다국어·목록·날짜·캘린더 회귀 검사 통과.
- 최신 운영 이미지 위에 hub.js와 hub.html 캐시 키만 변경했다. fuzz 없이 적용했고 다른 변경을 보존했다.
- 정적 파일 69개 SHA-256과 내부 HTTP 내용 일치, 실행 서비스 10개 정상. 다른 서비스 컨테이너·이미지 변경 없음.
- HTTPS 인증서·비로그인 401 확인. 호스트 DNS 제한으로 로컬 Caddy 주소를 지정했다.
- 운영 계정의 실제 논문 수정은 수행하지 않았으며, 브라우저 검사는 격리된 합성 데이터를 사용했다.
- 이미지: `sha256:265b12326b670bb5d48679a83003e3428c49ed6705efe3b48d9ebbd2faac09c8`
- 릴리스: `/home/qlab/.local/state/paper-workspace/releases/20261112-preview-stability-wj8kmbpe`
- 복구 설정: `/home/qlab/.local/state/paper-workspace/releases/20261112-preview-stability-wj8kmbpe/runtime-previous/runtime.compose.json`
