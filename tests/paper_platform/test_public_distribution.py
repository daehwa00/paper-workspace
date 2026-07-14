import json
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[2]


def test_runtime_is_project_agnostic() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    web_image = (ROOT / "infra/paper-workspace/Dockerfile").read_text(encoding="utf-8")
    compiler_image = (ROOT / "apps/paper_workspace/compiler/Dockerfile").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")

    assert "PAPER_PROJECT_DIR" in compose
    assert "../../paper/" not in compose
    assert "paper/vendor" not in web_image
    assert "paper/" not in compiler_image
    assert "KIT =" not in compiler
    assert "aaai2027" not in compiler


def test_example_project_has_a_manifest_and_no_conference_assets() -> None:
    example = ROOT / "examples/paper-workspace-project"
    manifest = json.loads((example / "project.json").read_text(encoding="utf-8"))

    assert manifest["entrypoint"] == "main.tex"
    assert {item["path"] for item in manifest["files"]} >= {"main.tex", "references.bib"}
    assert (example / "main.tex").is_file()
    assert not any("aaai" in path.name.lower() for path in example.rglob("*"))


def test_example_project_library_has_a_hub_catalog_and_slug_project() -> None:
    library = ROOT / "examples/project-library"
    catalog = json.loads((library / "index.json").read_text(encoding="utf-8"))
    assert catalog["projects"]
    project = catalog["projects"][0]
    assert project["slug"] == "example-paper"
    project_root = library / project["slug"]
    manifest = json.loads((project_root / "project.json").read_text(encoding="utf-8"))
    assert project["display_name"] == manifest["display_name"] == "A Reusable Paper Workspace"
    assert "\\title{A Reusable Paper Workspace}" in (project_root / "main.tex").read_text(encoding="utf-8")
    assert (project_root / "project.json").is_file()
    assert (project_root / "main.tex").is_file()
    assert (library / project["slug"] / "thumbnail.png").is_file()


def test_publication_files_explain_safe_export_and_secret_handling() -> None:
    documentation_root = ROOT / "apps/paper_workspace" if (ROOT / "apps/paper_workspace/README.md").exists() else ROOT
    readme = (documentation_root / "README.md").read_text(encoding="utf-8")
    notices = (documentation_root / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    env_example = (ROOT / "infra/paper-workspace/.env.example").read_text(encoding="utf-8")

    for heading in ("Quick start", "Connect your manuscript", "Codex integration", "Public deployment", "Troubleshooting"):
        assert heading in readme
    assert "auth.json" in readme
    assert "commit" in readme.lower()
    korean = (documentation_root / "README.ko.md").read_text(encoding="utf-8")
    for heading in ("빠른 시작", "내 논문 연결", "Codex 연결", "외부 공개", "문제 해결"):
        assert heading in korean
    assert "PDF.js" in notices
    assert "CODEX_BRIDGE_TOKEN" in env_example
    assert "PAPER_PROJECT_DIR" in env_example
    assert "/home/qlab" not in env_example


def test_public_readme_includes_safe_example_demo_assets() -> None:
    documentation_root = ROOT / "apps/paper_workspace" if (ROOT / "apps/paper_workspace/README.md").exists() else ROOT
    readme = (documentation_root / "README.md").read_text(encoding="utf-8")
    demo = ROOT / "docs/demo"

    assert "examples/paper-workspace-project" in readme
    assert "no research manuscript" in readme.lower()
    for feature in (
        "One workspace for the whole paper",
        "View all features",
        "full path",
        "visible page and scroll position",
        "workspace health center",
        "previous requests and proposals",
        "BibTeX",
        "light, dark, or system",
    ):
        assert feature in readme
    korean = (documentation_root / "README.ko.md").read_text(encoding="utf-8")
    for feature in ("논문의 전 과정을 하나의 작업공간에서", "전체 기능 보기", "전체 경로", "작업공간 상태 센터", "새 대화", "라이트·다크·시스템"):
        assert feature in korean
    assert readme.count("<details>") == readme.count("</details>") == 1
    assert korean.count("<details>") == korean.count("</details>") == 1
    assert readme.count("docs/demo/edit-and-render-flow.gif") == 1
    assert (demo / "edit-and-render-flow.gif").is_file()
    assert not (demo / "workspace-overview.png").exists()
    assert not (demo / "collaboration-review.png").exists()

    capture = (
        ROOT / "apps/paper_workspace/collaboration/capture-demo.mjs"
    ).read_text(encoding="utf-8")
    assert "PAPER_DEMO_URL" in capture
    assert "PAPER_DEMO_PASSWORD" in capture
    assert "paper.glowme.kr" not in capture
    assert "210628" not in capture


def test_public_export_is_allowlist_based() -> None:
    exporter = (ROOT / "scripts/paper_platform/export_public_workspace.py").read_text(encoding="utf-8")

    assert "PUBLIC_PATHS" in exporter
    assert "paper/" not in exporter
    assert "auth.json" in exporter
    assert '"node_modules"' in exporter
    assert '"test-results"' in exporter
    assert '"playwright-report"' in exporter
    assert "secret" in exporter.lower()
    for private_name in (".env.auth", ".env.password", ".auth", "allowed-emails"):
        assert private_name in exporter


def test_public_export_installs_a_pinned_history_secret_scan(tmp_path: Path) -> None:
    module_path = ROOT / "scripts/paper_platform/export_public_workspace.py"
    spec = importlib.util.spec_from_file_location("paper_public_exporter_workflow", module_path)
    assert spec and spec.loader
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)

    destination = tmp_path / "public"
    exporter.export(destination)
    workflow = (destination / ".github/workflows/security.yml").read_text(encoding="utf-8")
    assert "fetch-depth: 0" in workflow
    assert "gitleaks/gitleaks-action@83373cf2f8c4db6e24b41c1a9b086bb9619e9cd3" in workflow


def test_public_export_scans_large_files_and_chunk_boundaries(tmp_path: Path) -> None:
    module_path = ROOT / "scripts/paper_platform/export_public_workspace.py"
    spec = importlib.util.spec_from_file_location("paper_public_exporter", module_path)
    assert spec and spec.loader
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)

    safe = tmp_path / "safe.bin"
    safe.write_bytes(b"x" * 2_100_000)
    exporter.verify_export(tmp_path)

    token = b"github_pat_" + (b"A" * 32)
    unsafe = tmp_path / "large.bin"
    unsafe.write_bytes(
        b"x" * (exporter.SECRET_SCAN_CHUNK_BYTES - len(b"github_pat_") + 3)
        + token
        + b"x" * 2_100_000
    )
    with pytest.raises(RuntimeError, match="Possible secret found in large.bin"):
        exporter.verify_export(tmp_path)


def test_backup_service_is_persistent_and_routed_separately() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile").read_text(encoding="utf-8")
    exporter = (ROOT / "scripts/paper_platform/export_public_workspace.py").read_text(
        encoding="utf-8"
    )

    assert "backup:" in compose
    assert "BACKUP_DATA_SOURCE:-backup_data" in compose
    assert "BACKUP_EXPORT_SOURCE:-backup_exports" in compose
    assert "backup_data:" in compose
    assert "BACKUP_RETENTION" in compose
    assert "handle_path /api/backups/*" in caddy
    assert caddy.index("handle_path /api/backups/*") < caddy.index("handle_path /api/*")
    assert 'Path("apps/paper_workspace/backup")' in exporter
    backup_image = (ROOT / "apps/paper_workspace/backup/Dockerfile").read_text(encoding="utf-8")
    assert "chmod 755 /app" in backup_image


def test_optional_github_oauth_override_protects_every_route() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.auth.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile.auth").read_text(encoding="utf-8")
    env = (ROOT / "infra/paper-workspace/.env.auth.example").read_text(encoding="utf-8")

    assert "oauth2-proxy:v7.15.2" in compose
    assert "--provider=google" in compose
    assert "allowed-emails:/etc/oauth2-proxy/allowed-emails:ro" in compose
    assert "forward_auth oauth2-proxy:4180" in caddy
    assert "copy_headers X-Auth-Request-User" in caddy
    assert "oauth2/start?rd={http.request.uri}" in caddy
    assert "--trusted-proxy-ip=" in compose
    for route in ("/api/codex", "/api/backups/*", "/api/*", "/collab"):
        assert route in caddy
    assert "OAUTH2_PROXY_COOKIE_SECRET" in env
    assert "OAUTH2_PROXY_REDIRECT_URL" in env
    assert ".auth/allowed-emails" in (ROOT / "infra/paper-workspace/allowed-emails.example").read_text(encoding="utf-8")


def test_optional_shared_password_override_is_exported_without_a_secret() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.password.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile.password").read_text(encoding="utf-8")
    env = (ROOT / "infra/paper-workspace/.env.password.example").read_text(encoding="utf-8")

    assert "password-gate" in compose
    assert "forward_auth password-gate:8079" in caddy
    assert '["caddy", "run", "--config"' in compose
    assert "PAPER_ACCESS_PASSWORD=replace-with-your-private-lab-password" in env
    assert "210628" not in env


def test_public_edge_and_collaboration_are_hardened() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    caddy_files = [
        (ROOT / "infra/paper-workspace" / name).read_text(encoding="utf-8")
        for name in ("Caddyfile", "Caddyfile.auth", "Caddyfile.password")
    ]
    collaboration = (ROOT / "apps/paper_workspace/collaboration/server.cjs").read_text(encoding="utf-8")
    collaboration_image = (ROOT / "apps/paper_workspace/collaboration/Dockerfile").read_text(encoding="utf-8")
    caddy_image = (ROOT / "infra/paper-workspace/Caddy.Dockerfile").read_text(encoding="utf-8")

    assert "caddy:2.11.4-alpine" in compose
    assert 'user: "1000:1000"' in compose
    assert "service_completed_successfully" in compose
    assert "net.ipv4.ip_unprivileged_port_start" in compose
    assert "compiler_internal:" in compose and "internal: true" in compose
    assert ":/projects:ro" not in compose
    assert ":/project-default:ro" not in compose
    assert "COLLAB_MAX_PAYLOAD_BYTES" in compose
    assert "projects.json:ro" in compose
    assert "collaboration-storage-init:" in compose
    assert 'user: "${HOST_UID:-1000}:${HOST_GID:-1000}"' in compose
    for caddy in caddy_files:
        assert "script-src 'self'" in caddy
        assert "frame-ancestors 'none'" in caddy
        assert "X-Frame-Options DENY" in caddy
    assert "allowedProjectSlugs" in collaboration
    assert "maxPayload" in collaboration
    assert "storage quota exceeded" in collaboration
    assert "chmod -R a+rX /app" in collaboration_image
    assert "install -d -m 0755 /etc/paper-caddy" in caddy_image
    assert "USER 1000:1000" in caddy_image


def test_browser_error_reports_are_redacted_post_bodies() -> None:
    bootstrap = (ROOT / "apps/paper_workspace/static/bootstrap.js").read_text(encoding="utf-8")
    workspace = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.html").read_text(encoding="utf-8")
    nginx = (ROOT / "infra/paper-workspace/nginx.conf").read_text(encoding="utf-8")

    assert "method: 'POST'" in bootstrap
    assert "redactError" in bootstrap
    assert "__client_error.gif?" not in workspace
    assert "__BOOTSTRAP_JS_HASH__" in workspace and "__BOOTSTRAP_JS_HASH__" in hub
    assert "access_log off" in nginx
    assert "client_max_body_size 2k" in nginx


def test_brand_icons_are_public_before_authentication() -> None:
    password_caddy = (ROOT / "infra/paper-workspace/Caddyfile.password").read_text(encoding="utf-8")
    oauth_caddy = (ROOT / "infra/paper-workspace/Caddyfile.auth").read_text(encoding="utf-8")
    icon_paths = ("/favicon.ico", "/apple-touch-icon.png", "/site.webmanifest")

    for path in icon_paths:
        assert path in password_caddy
        assert path in oauth_caddy

    assert password_caddy.index("/apple-touch-icon.png") < password_caddy.index("forward_auth")
    assert oauth_caddy.index("@public_brand_asset") < oauth_caddy.index("forward_auth")
