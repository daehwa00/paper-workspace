[English](README.md) | **한국어**

# Paper Workspace

브라우저에서 LaTeX 논문을 작성하고 PDF를 바로 확인하며, 공동 편집·인라인 리뷰·Codex 수정 제안을 함께 사용할 수 있는 self-hosted 작업공간입니다.

- 구문 강조, 검색, 자동완성, 실행 취소/다시 실행을 지원하는 LaTeX 편집기
- 격리된 TeX Live 컴파일과 SyncTeX 기반 PDF↔원본 이동
- 공동 작업자 커서와 선택 영역 댓글·할 일
- 그림 미리보기, 폴더 업로드, 제출용 ZIP과 사전 검사
- 자동 서버 백업과 버전 복원
- 데스크톱 다중 패널 및 모바일 파일·원고·PDF·도우미 집중 화면

기본 UI는 영어입니다. 저장된 선택이 없고 브라우저 언어가 한국어일 때만 한국어를 자동 선택하며, 우측 상단 선택값은 브라우저에 유지됩니다. `?lang=en` 또는 `?lang=ko`를 붙이면 언어가 고정된 링크를 공유할 수 있습니다.

## 데모

아래 화면은 공개 Example Paper를 실제로 LaTeX 컴파일해 촬영했습니다. 비공개 원고·심사 자료·서버 주소·인증 정보는 포함하지 않았습니다.

![Paper Workspace example project](docs/demo/workspace-overview.png)

![Realtime collaboration and inline review](docs/demo/collaboration-review.png)

![Edit, save, and render workflow](docs/demo/edit-and-render-flow.gif)

## 빠른 시작

Git, Docker Engine, Docker Compose v2가 필요합니다. 최초 TeX Live 빌드는 수 GB를 내려받을 수 있습니다.

```bash
cp infra/paper-workspace/.env.example infra/paper-workspace/.env
docker compose -f infra/paper-workspace/compose.yaml up --build -d
```

`https://localhost`를 엽니다. 로컬 Caddy 인증서를 신뢰하기 전에는 브라우저 경고가 표시될 수 있습니다.

```bash
docker compose -f infra/paper-workspace/compose.yaml ps
docker compose -f infra/paper-workspace/compose.yaml logs -f workspace compiler
docker compose -f infra/paper-workspace/compose.yaml down
```

## 여러 논문을 한 서버에서 관리

서버 루트에는 논문 목록이, 각 논문에는 slug 기반 고정 주소가 생깁니다.

```text
https://paper.example.com/
https://paper.example.com/p/aaai27
https://paper.example.com/p/forecasting
```

`PAPER_PROJECTS_DIR` 아래에 slug별 폴더를 만들고 루트 `index.json`에 카드를 등록합니다.

```json
{
  "projects": [
    {"slug":"aaai27", "display_name":"AAAI-27 Paper", "description":"Main submission"},
    {"slug":"forecasting", "display_name":"Forecasting Study", "description":"Time-series experiments"}
  ]
}
```

slug에는 영문·숫자·`-`·`_`만 사용하세요. 제목을 바꿔도 주소는 유지됩니다. 단일 논문은 `PAPER_PROJECT_DIR`, 목록 허브는 `PAPER_PROJECTS_DIR`를 사용합니다.

## 내 논문 연결

1. 예제 프로젝트를 이 저장소 밖의 새 폴더로 복사합니다.
2. `main.tex`, bibliography, 학회 `.cls`/`.sty`/`.bst`, 그림을 넣습니다.
3. 컴파일 입력을 `project.json`에 등록합니다.
4. `PAPER_PROJECT_DIR`을 연결하거나 `PAPER_PROJECTS_DIR` 아래에 배치한 뒤 Compose를 재시작합니다.

```json
{
  "entrypoint": "main.tex",
  "preview_entrypoints": ["main.tex", "supplement.tex"],
  "page_limit": 7,
  "files": [
    {"path":"main.tex", "type":"text"},
    {"path":"Figures/plot.pdf", "type":"asset"}
  ]
}
```

경로는 상대 경로여야 하며 `..`를 사용할 수 없습니다. 선택한 `.tex`가 독립 문서이면 직접 컴파일하고, appendix 같은 fragment이면 메인 preamble을 재사용합니다. 컴파일 한도는 파일 120개, 요청 48 MB, binary asset 합계 32 MB이고 브라우저 업로드는 파일당 8 MB입니다.

서버 파일은 브라우저 작업공간의 초기 seed입니다. 배포한 원고로 기존 브라우저 seed를 갱신하려면 `project.json`의 `version`을 올리세요.

## 일상 작업

- 편집 후 자동 저장과 PDF 갱신
- `Cmd/Ctrl+S`, `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`
- PDF 클릭으로 원본 이동, 원본에서 `Cmd/Ctrl+클릭`으로 PDF 이동
- 편집기 또는 PDF 위에서 `Cmd/Ctrl+휠` 확대·축소
- 선택 문장에 댓글·할 일·Codex 수정 요청 추가
- 프로젝트 트리에 파일·폴더 드래그, 그림 미리보기
- **검사**에서 인용·익명성 후보·누락 그림·페이지 수·글꼴 확인
- **Source ZIP 만들기**로 컴파일 가능한 제출 파일과 `SHA256SUMS` 생성

제출 전에는 학회 공식 검사도 반드시 실행하세요.

## 10분 단위 서버 백업

변경된 프로젝트는 10분마다 서버 복구 지점을 만들며 기본적으로 최근 50개를 보관합니다. **자료** 탭에서 중요한 버전에 이름을 붙이고 파일을 비교하거나 복원할 수 있습니다.

운영 환경에서는 기본 DB·자산과 압축 snapshot export를 서로 다른 디스크나 NFS 경로에 두세요.

```dotenv
BACKUP_RETENTION=50
BACKUP_DATA_SOURCE=/mnt/paper-primary
BACKUP_EXPORT_SOURCE=/mnt/offhost-paper-backups
```

두 경로는 컨테이너 UID 10001이 쓸 수 있어야 합니다. `docker compose down -v`는 named volume과 snapshot을 삭제하므로 일반 종료에는 `down`을 사용하세요.

## Codex 연결

Codex는 선택 문장, 요청, 현재 파일 문맥을 받아 적용 전 수정안을 반환합니다. 원고 파일을 직접 수정하지 않습니다.

```dotenv
CODEX_AUTH_FILE=/absolute/path/to/.codex/auth.json
CODEX_BRIDGE_TOKEN=긴-무작위-문자열
HOST_UID=1000
HOST_GID=1000
```

`auth.json`과 `.env`는 커밋하지 마세요. bridge token은 내부 서비스를 보호할 뿐 웹사이트 방문자 인증을 대신하지 않습니다.

## 외부 공개

VPN, identity-aware proxy, Google OAuth 또는 포함된 소규모 연구실용 password gate 뒤에서 운영하세요. 익명 컴파일러나 Codex bridge를 인터넷에 직접 노출하지 마세요.

```dotenv
PAPER_DOMAIN=paper.example.com
PAPER_BIND_ADDRESS=0.0.0.0
```

DNS를 서버로 연결하고 80/443 포트를 열면 Caddy가 TLS를 관리합니다. Google OAuth는 `.env.auth`, `.auth/allowed-emails`, `compose.auth.yaml`로 설정합니다.

신뢰하는 소규모 연구실에서는 password 예제를 복사하고 고유한 비밀번호와 긴 session secret을 설정한 뒤 override를 실행할 수 있습니다.

```bash
cp infra/paper-workspace/.env.password.example infra/paper-workspace/.env.password
docker compose -f infra/paper-workspace/compose.yaml \
  -f infra/paper-workspace/compose.password.yaml up --build -d
```

공유 비밀번호에는 개인별 역할·폐기·감사 기록이 없습니다. 노출되면 즉시 교체하세요.

## 폴더 구조

```text
apps/paper_workspace/              애플리케이션 서비스와 UI
infra/paper-workspace/             Docker Compose, Caddy, nginx
examples/paper-workspace-project/  공개 최소 예제
docs/paper-platform/               아키텍처와 보안 경계
scripts/paper_platform/            공개 export 도구
tests/paper_platform/              회귀 테스트
```

연구 원고는 런타임에 연결하며 공개 플랫폼 저장소에 포함하지 않습니다.

## GitHub에 공개하기

연구 저장소를 직접 push하지 말고 allowlist exporter로 플랫폼만 분리합니다.

```bash
python scripts/paper_platform/export_public_workspace.py /tmp/paper-workspace-public
cd /tmp/paper-workspace-public
pytest -q tests/paper_platform
git status --short
```

exporter는 원고·실험·데이터·결과를 제외합니다. `.gitignore`는 이미 Git history에 들어간 비밀을 지우지 못하므로 공개 전 history를 검사하고 노출된 자격증명은 폐기하세요.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| PDF 컴파일 오류 | 누락된 `.sty`/`.bst`, 그림 경로 대소문자, `project.json` 항목 |
| 인용이 `??` | BibTeX key, bibliography 경로, 컴파일 로그 |
| 서버 수정이 안 보임 | 브라우저 초안과 `project.json` version |
| Codex 401/429/timeout | token, auth-file 권한, UID/GID, 요청 제한 |
| 공동 작업자가 offline | Caddy `/collab` proxy와 브라우저 WebSocket 오류 |
| 백업 기록이 비어 있음 | `backup` 로그와 volume; 첫 snapshot은 최대 10분 소요 |
| 빈 화면 또는 옛 UI | hard refresh 후 필요한 경우 손상된 사이트 저장소 초기화 |

## 개발 및 검증

```bash
pytest -q tests/paper_platform
node --check apps/paper_workspace/static/app.js
node --check apps/paper_workspace/collaboration/client.js
python -m py_compile apps/paper_workspace/compiler/server.py apps/paper_workspace/backup/server.py
docker compose -f infra/paper-workspace/compose.yaml config --quiet
```

실제 데모는 `apps/paper_workspace/collaboration`에서 공개 Example Paper를 대상으로 `npm run capture:demo`를 실행해 다시 만들 수 있습니다. GIF 생성에는 ImageMagick이 필요합니다.
