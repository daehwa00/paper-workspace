# Paper Workspace

브라우저에서 LaTeX를 편집하고, 격리된 TeX Live 컨테이너로 PDF를 만들며, PDF에서 원본 줄로 이동하고, 공동 작업자의 위치와 Codex 수정 제안을 확인하는 self-hosted 논문 작업 공간입니다.

> **현재 범위:** 편집 중인 문서는 브라우저 `localStorage`에 즉시 저장되고, 변경된 프로젝트는 10분 간격으로 서버 SQLite에 복구 지점을 만듭니다. WebSocket은 접속 상태와 커서만 공유하며 텍스트를 병합하지 않습니다. 계정·권한 관리도 아직 없으므로 중요한 원고는 Git 같은 별도 저장소에도 보관하세요.

## 빠른 시작

필요한 것은 Git, Docker Engine, Docker Compose v2입니다. TeX Live 이미지가 크므로 첫 빌드는 수 GB를 내려받을 수 있습니다.

```bash
cp infra/paper-workspace/.env.example infra/paper-workspace/.env
docker compose -f infra/paper-workspace/compose.yaml up --build -d
```

기본 샘플은 `examples/paper-workspace-project`이고 서비스는 로컬 컴퓨터의 `https://localhost`에만 열립니다. 상태와 로그는 다음처럼 확인합니다.

```bash
docker compose -f infra/paper-workspace/compose.yaml ps
docker compose -f infra/paper-workspace/compose.yaml logs -f workspace compiler
docker compose -f infra/paper-workspace/compose.yaml down
```

브라우저가 로컬 Caddy 인증서를 신뢰하지 않으면 개발용 인증서 경고가 표시될 수 있습니다.

## 내 논문 연결

1. 예제 폴더를 Git 밖의 새 폴더로 복사합니다.
2. `main.tex`, `.bib`, 학회에서 직접 받은 `.cls`·`.sty`·`.bst`, 그림을 그 폴더에 둡니다.
3. `project.json`의 `files`에 컴파일에 필요한 파일을 모두 적습니다. 그림은 `{"path":"Figures/plot.pdf","type":"asset"}`처럼 표시합니다. 원본 위치와 컴파일 위치가 다르면 `{"path":"venue.sty","source":"vendor/venue.sty"}`처럼 안전한 상대 경로를 매핑할 수 있습니다.
4. `.env`의 `PAPER_PROJECT_DIR`을 그 폴더의 절대 경로로 바꾸고 Compose를 다시 시작합니다.

`entrypoint`는 현재 `main.tex`이어야 합니다. 파일 경로에는 절대 경로나 `..`를 사용할 수 없습니다. 컴파일 API는 최대 120개 파일, 요청 12 MB, binary asset 합계 8 MB를 허용합니다. 브라우저 업로드는 파일당 2 MB로 제한됩니다.

서버의 프로젝트 파일은 시작 seed입니다. 브라우저에 수정본이 있으면 자동 백업 초안이 만들어질 수 있습니다. 완전히 새 프로젝트로 시작하려면 브라우저 사이트 데이터에서 `paper-workspace` 저장 항목을 지우거나 새 브라우저 프로필을 사용하세요.

## 일상 작업

- 입력 후 자동 저장과 PDF 갱신
- `Cmd/Ctrl+S`, `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`
- PDF 본문 클릭으로 SyncTeX 원본 줄 이동
- 선택 영역의 댓글 또는 Codex 수정 요청
- 파일·폴더 drag-and-drop, PDF 다운로드
- 사이드바·도우미 접기, 각 패널과 편집기/PDF 확대·축소

## 10분 단위 서버 백업

브라우저의 즉시 자동 저장과 별도로, 내용이 바뀐 프로젝트는 10분마다 서버에 snapshot을 저장합니다. snapshot에는 프로젝트 파일, 댓글, 제목 등 복원에 필요한 편집 상태가 들어가며 PDF와 SyncTeX처럼 다시 생성할 수 있는 출력물은 넣지 않습니다. 기본적으로 프로젝트별 최근 50개를 보관합니다.

백업은 Docker named volume `backup_data`의 `/data/backups.sqlite3`에 저장됩니다. 보관 개수는 `.env`에서 조절할 수 있습니다.

```dotenv
BACKUP_RETENTION=50
```

백업 기록에서 원하는 시점을 복원할 수 있으며, 복원하기 전 현재 상태도 보존합니다. 다만 이 기능은 계정 시스템이나 실시간 공동 편집 이력이 아닙니다. 동일한 프로젝트 식별자를 아는 방문자를 구분하지 못하므로 외부 공개 시 반드시 사이트 전체에 인증과 프로젝트 권한 검사를 추가하세요. `docker compose down -v`는 named volume과 모든 snapshot을 삭제하므로 일반 종료에는 `down`만 사용하고, 서버 자체도 정기적으로 별도 백업하세요.

## Codex 연결

Codex는 선택한 문장, 요청 문구, 현재 파일 문맥을 읽고 **적용 전 제안**만 반환합니다. 브리지는 read-only·ephemeral Codex 실행을 사용하며 원고 파일을 직접 수정하지 않습니다.

`.env`에서 다음을 설정합니다.

```dotenv
CODEX_AUTH_FILE=/absolute/path/to/.codex/auth.json
CODEX_BRIDGE_TOKEN=긴-무작위-문자열
HOST_UID=1000
HOST_GID=1000
```

`auth.json`과 `.env`는 절대 커밋하지 마세요. Caddy가 bridge token을 서버 내부에서 주입하므로 브라우저에는 키가 노출되지 않지만, 이것은 방문자 인증이 아닙니다. 외부 공개 시 로그인 보호 없이 Codex를 열면 누구나 운영자 계정의 사용량을 소비할 수 있습니다.

## 외부 공개

권장 방식은 VPN 또는 identity-aware proxy 뒤에서 사용하는 것입니다. 인증 계층을 준비한 후에만 다음 값을 사용하세요.

```dotenv
PAPER_DOMAIN=paper.example.com
PAPER_BIND_ADDRESS=0.0.0.0
```

DNS를 서버로 연결하고 80/443 포트를 허용하면 Caddy가 TLS 인증서를 관리합니다. 컴파일러와 collaboration socket에도 사용자 인증, 프로젝트 권한, 요청 quota가 필요합니다. 현재 구현을 익명 인터넷 서비스로 운영하는 것은 권장하지 않습니다.

## 폴더 구조

```text
apps/paper_workspace/        UI, compiler, backup, collaboration, Codex bridge
infra/paper-workspace/       Docker Compose, Caddy, nginx
examples/paper-workspace-project/  공개 가능한 최소 예제
docs/paper-platform/         실제 구현과 보안 경계
scripts/paper_platform/      공개 저장소 export/preflight
tests/paper_platform/        회귀 및 공개 경계 테스트
```

현재 연구 원고는 이 구조에 포함되지 않으며 런타임에 `PAPER_PROJECT_DIR`로만 연결합니다.

## GitHub에 공개하기

연구 저장소 전체를 push하지 말고 allowlist exporter를 사용합니다.

```bash
python scripts/paper_platform/export_public_workspace.py /tmp/paper-workspace-public
cd /tmp/paper-workspace-public
git init
git status --short
pytest -q tests/paper_platform
```

exporter는 플랫폼 경로만 복사하고 원고·실험·데이터·결과를 가져오지 않습니다. `.gitignore`는 새 파일을 막을 뿐 이미 추적되거나 과거 commit에 들어간 비밀을 지우지 못합니다. push 전 전체 Git history를 secret scanner로 확인하고, 노출된 인증은 폐기·재발급하세요.

MIT 라이선스는 export된 플랫폼 코드에만 적용됩니다. 연구 monorepo나 사용자가 마운트한 원고에는 자동 적용되지 않습니다. PDF.js의 Apache-2.0 고지는 `THIRD_PARTY_NOTICES.md`와 vendored LICENSE에 보존됩니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| PDF 컴파일 오류 | 오른쪽 로그의 누락된 `.sty`, `.bst`, 그림 경로와 대소문자를 확인하고 모두 manifest에 추가합니다. |
| 인용이 `??` | BibTeX key, `references.bib`, `\\bibliography{...}`를 확인합니다. BibTeX는 aux에 bibliography가 있을 때만 실행됩니다. |
| 서버 파일 수정이 안 보임 | 브라우저 로컬 초안과 project version을 확인하고 `project.json`의 `version`을 올립니다. |
| Codex 401/429/timeout | token, auth file 권한, UID/GID, 10분 요청 제한과 120초 timeout을 확인합니다. |
| 공동 작업자가 offline | Caddy `/collab` reverse proxy와 브라우저 WebSocket 오류를 확인합니다. |
| 백업 기록이 비어 있음 | 첫 snapshot은 변경 후 최대 10분 뒤 만들어집니다. `backup` 컨테이너 로그와 `backup_data` volume을 확인합니다. |
| 백업 복원이 안 됨 | snapshot의 프로젝트 식별자가 현재 프로젝트와 같은지 확인하고 `/api/backups/...` 응답을 확인합니다. |
| 빈 화면/옛 UI | hard refresh 후 사이트 캐시와 localStorage 손상 여부를 확인합니다. 손상된 JSON은 자동 초기화됩니다. |

## 개발 및 검증

```bash
pytest -q tests/paper_platform
node --check apps/paper_workspace/static/app.js
python -m py_compile apps/paper_workspace/compiler/server.py apps/paper_workspace/backup/server.py apps/paper_workspace/collaboration/server.py
docker compose -f infra/paper-workspace/compose.yaml config --quiet
```

기능 주장은 코드와 테스트로 확인 가능한 범위만 문서화합니다. 향후 과제는 인증/ACL, CRDT/OT 텍스트 동기화, 사용자별 감사 이력, 외부 object storage 복제, compiler job queue와 quota입니다.
