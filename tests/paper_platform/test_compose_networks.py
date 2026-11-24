"""Check resolved deployment networks without starting services or reading secrets."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_ROOT = ROOT / "infra/paper-workspace"


def compose_config(tmp_path: Path, override: str | None = None, *additional: str) -> dict:
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("Docker Compose is not installed")
    version = subprocess.run([docker, "compose", "version"], capture_output=True)
    if version.returncode:
        pytest.skip("Docker Compose is not installed")

    # Resolve relative env files in a disposable project directory. Real local
    # credentials are neither needed nor loaded by these configuration checks.
    for name in (".env", ".env.auth", ".env.password"):
        (tmp_path / name).write_text("", encoding="utf-8")
    command = [
        docker, "compose", "--project-directory", str(tmp_path),
        "--env-file", str(tmp_path / ".env"),
        "-f", str(COMPOSE_ROOT / "compose.yaml"),
    ]
    if override:
        command.extend(["-f", str(COMPOSE_ROOT / override)])
    for filename in additional:
        command.extend(["-f", str(COMPOSE_ROOT / filename)])
    command.extend(["config", "--format", "json"])
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def has_egress(config: dict, service: str) -> bool:
    networks = config["services"][service].get("networks", {})
    return any(not config["networks"][name].get("internal", False) for name in networks)


def test_google_oauth_can_reach_its_provider_without_publishing_a_port(tmp_path: Path) -> None:
    config = compose_config(tmp_path, "compose.auth.yaml")

    assert has_egress(config, "oauth2-proxy"), "Google discovery and token exchange need egress"
    assert "auth_internal" in config["services"]["oauth2-proxy"]["networks"]
    assert not config["services"]["oauth2-proxy"].get("ports")


@pytest.mark.parametrize("override", [None, "compose.auth.yaml", "compose.password.yaml"])
def test_auth_overrides_preserve_backend_isolation_and_proxy_routes(
    tmp_path: Path, override: str | None,
) -> None:
    config = compose_config(tmp_path, override)
    proxy_networks = config["services"]["caddy"]["networks"]

    for service in ("compiler", "backup", "collaboration", "workspace"):
        assert not has_egress(config, service), service
        assert not config["services"][service].get("ports"), service
        assert set(config["services"][service]["networks"]) & set(proxy_networks), service
    if override:
        assert config["networks"]["auth_internal"]["internal"] is True
        assert "auth_internal" in proxy_networks


def test_account_overlay_uses_authenticated_backup_actor(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPER_ACCOUNTS_DIR", str(tmp_path))
    config = compose_config(tmp_path, "compose.password.yaml", "compose.accounts.yaml")
    assert config["services"]["backup"]["environment"]["BACKUP_ACTOR_MODE"] == "proxy"


@pytest.mark.parametrize("filename", ["Caddyfile.password", "Caddyfile.accounts"])
def test_public_login_route_overwrites_client_ip(filename):
    config = (COMPOSE_ROOT / filename).read_text()
    public_auth = config.split("handle /_auth/*", 1)[1].split("@public_brand_asset", 1)[0]
    assert "header_up X-Paper-Client-IP {http.request.remote.host}" in public_auth


@pytest.mark.parametrize(
    ("filename", "actor"),
    [
        ("Caddyfile", '"local-user"'),
        ("Caddyfile.password", '"shared-password-user"'),
        ("Caddyfile.auth", "{http.request.header.X-Auth-Request-Email}"),
    ],
)
def test_shared_backup_policies_replace_untrusted_headers(filename, actor):
    config = (COMPOSE_ROOT / filename).read_text()
    backup = config.split("handle_path /api/backups/*", 1)[1].split("handle_path /api/*", 1)[0]
    assert f"header_up X-Paper-Actor {actor}" in backup
    assert 'header_up X-Paper-Role "editor"' in backup
    assert "header_up -X-Paper-Allowed-Projects" in backup


def test_oauth_keeps_verified_identity_until_backup_proxy():
    config = (COMPOSE_ROOT / "Caddyfile.auth").read_text()
    protected = config.split("handle {", 1)[1]
    assert protected.lstrip().startswith("route {")
    assert protected.index("request_header -X-Auth-Request-Email") < protected.index("forward_auth")
    assert protected.index("forward_auth") < protected.index("handle_path /api/backups/*")
