import json
from pathlib import Path


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


def test_publication_files_explain_safe_export_and_secret_handling() -> None:
    documentation_root = ROOT / "apps/paper_workspace" if (ROOT / "apps/paper_workspace/README.md").exists() else ROOT
    readme = (documentation_root / "README.md").read_text(encoding="utf-8")
    notices = (documentation_root / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    env_example = (ROOT / "infra/paper-workspace/.env.example").read_text(encoding="utf-8")

    for heading in ("빠른 시작", "내 논문 연결", "Codex 연결", "외부 공개", "문제 해결"):
        assert heading in readme
    assert "auth.json" in readme
    assert "커밋" in readme
    assert "PDF.js" in notices
    assert "CODEX_BRIDGE_TOKEN" in env_example
    assert "PAPER_PROJECT_DIR" in env_example
    assert "/home/qlab" not in env_example


def test_public_readme_includes_safe_example_demo_assets() -> None:
    documentation_root = ROOT / "apps/paper_workspace" if (ROOT / "apps/paper_workspace/README.md").exists() else ROOT
    readme = (documentation_root / "README.md").read_text(encoding="utf-8")
    demo = ROOT / "docs/demo"

    assert "examples/paper-workspace-project" in readme
    assert "실제 연구 원고" in readme
    assert (demo / "workspace-overview.png").is_file()
    assert (demo / "edit-and-render-flow.gif").is_file()
    assert (demo / "workspace-overview.svg").is_file()


def test_public_export_is_allowlist_based() -> None:
    exporter = (ROOT / "scripts/paper_platform/export_public_workspace.py").read_text(encoding="utf-8")

    assert "PUBLIC_PATHS" in exporter
    assert "paper/" not in exporter
    assert "auth.json" in exporter
    assert "secret" in exporter.lower()
    for private_name in (".env.auth", ".env.password", ".auth", "allowed-emails"):
        assert private_name in exporter


def test_backup_service_is_persistent_and_routed_separately() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile").read_text(encoding="utf-8")
    exporter = (ROOT / "scripts/paper_platform/export_public_workspace.py").read_text(
        encoding="utf-8"
    )

    assert "backup:" in compose
    assert "backup_data:/data" in compose
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

    assert "oauth2-proxy:v7.12.0" in compose
    assert "--provider=google" in compose
    assert "allowed-emails:/etc/oauth2-proxy/allowed-emails:ro" in compose
    assert "forward_auth oauth2-proxy:4180" in caddy
    assert "copy_headers X-Auth-Request-User" in caddy
    assert "oauth2/start?rd={http.request.uri}" in caddy
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
    assert "PAPER_ACCESS_PASSWORD=replace-with-your-private-lab-password" in env
    assert "210628" not in env
