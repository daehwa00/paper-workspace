from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).parents[2]
SERVER = ROOT / "apps/paper_workspace/password_gate/server.py"


def load_gate():
    spec = importlib.util.spec_from_file_location("paper_password_gate", SERVER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_signed_session_is_valid_until_expiry(monkeypatch):
    gate = load_gate()
    monkeypatch.setattr(gate, "SESSION_SECRET", "test-secret")
    token, expires = gate.issue_session(now=100)
    assert gate.valid_session(f"paper_session={token}", now=expires - 1)
    assert not gate.valid_session(f"paper_session={token}", now=expires)
    assert not gate.valid_session("paper_session=forged.0", now=100)


def test_password_gate_files_configure_session_cookie_and_private_env() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.password.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile.password").read_text(encoding="utf-8")
    env = (ROOT / "infra/paper-workspace/.env.password.example").read_text(encoding="utf-8")

    assert "password-gate" in compose
    assert "paper_session" in (ROOT / "apps/paper_workspace/password_gate/server.py").read_text(encoding="utf-8")
    assert "HttpOnly; Secure; SameSite=Lax" in (ROOT / "apps/paper_workspace/password_gate/server.py").read_text(encoding="utf-8")
    assert "forward_auth password-gate:8079" in caddy
    assert "PAPER_ACCESS_PASSWORD" in env


def test_password_gate_login_is_mobile_safe_and_touch_accessible() -> None:
    source = SERVER.read_text(encoding="utf-8")
    assert "viewport-fit=cover" in source
    assert "*{{box-sizing:border-box}}" in source
    assert "width:min(380px,100%)" in source
    assert source.count("min-height:48px") >= 2
    assert "prefers-reduced-motion:reduce" in source
    assert ".env.password" in (ROOT / "infra/paper-workspace/.gitignore").read_text(encoding="utf-8")


def test_browser_requests_redirect_but_api_requests_stay_unauthorized() -> None:
    gate = (ROOT / "apps/paper_workspace/password_gate/server.py").read_text(encoding="utf-8")
    assert '"text/html" in self.headers.get("Accept", "")' in gate
    assert '"/_auth/login?" + urlencode' in gate
    assert "safe_redirect" in gate
    assert 'HTTPStatus.UNAUTHORIZED, {"authenticated": False}' in gate
