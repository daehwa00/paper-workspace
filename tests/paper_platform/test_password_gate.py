from __future__ import annotations

import importlib.util
import http.client
import threading
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


def test_language_resolution_follows_query_cookie_browser_then_english() -> None:
    gate = load_gate()

    assert gate.resolve_language("ko", "paper_language=en", "en-US") == "ko"
    assert gate.resolve_language(None, "paper_language=ko", "en-US") == "ko"
    assert gate.resolve_language(None, None, "en-US,en;q=0.9,ko;q=0.8") == "en"
    assert gate.resolve_language(None, None, "fr-FR,ko;q=0.9,en;q=0.7") == "ko"
    assert gate.resolve_language("unsupported", None, "fr-FR") == "en"
    assert gate.resolve_language(None, "malformed-cookie", None) == "en"


def test_language_preference_cookie_is_bounded_and_transport_safe() -> None:
    gate = load_gate()
    cookie = gate.language_cookie("ko-KR")

    assert cookie.startswith("paper_language=ko;")
    assert "Max-Age=31536000" in cookie
    assert "Path=/" in cookie
    assert "Secure" in cookie
    assert "SameSite=Lax" in cookie
    assert gate.language_cookie("not-supported").startswith("paper_language=en;")


def test_login_page_is_fully_localized_and_preserves_redirect() -> None:
    gate = load_gate()
    redirect = "/p/example-paper?view=files&tab=main"
    english = gate.render_login_page("en", redirect, "invalid_password").decode()
    korean = gate.render_login_page("ko", redirect, "invalid_password").decode()

    assert '<html lang="en">' in english
    assert "Sign in · Paper Workspace" in english
    assert "Access password" in english
    assert "The password is incorrect" in english
    assert '<html lang="ko">' in korean
    assert "접속 비밀번호" in korean
    assert "비밀번호가 올바르지 않습니다" in korean
    for page in (english, korean):
        assert "rd=%2Fp%2Fexample-paper%3Fview%3Dfiles%26tab%3Dmain" in page
        assert "lang=en" in page
        assert "lang=ko" in page
        assert 'aria-label="Language"' in page or 'aria-label="언어"' in page
        assert 'role="alert"' in page


def test_accept_language_honors_quality_and_rejects_zero_quality() -> None:
    gate = load_gate()

    assert gate.accepted_language("ko;q=0.5,en;q=0.9") == "en"
    assert gate.accepted_language("ko;q=0,en;q=0") is None
    assert gate.accepted_language("ko-KR,en-US;q=0.8") == "ko"


def test_login_handler_persists_explicit_language_and_issues_both_cookies(monkeypatch) -> None:
    gate = load_gate()
    monkeypatch.setattr(gate, "PASSWORD", "test-password")
    monkeypatch.setattr(gate, "SESSION_SECRET", "test-session-secret")
    server = gate.ThreadingHTTPServer(("127.0.0.1", 0), gate.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
    try:
        connection.request("GET", "/login?rd=%2Fp%2Fexample&lang=ko", headers={"Accept-Language": "en"})
        response = connection.getresponse()
        page = response.read().decode()
        assert response.status == 200
        assert response.getheader("Content-Language") == "ko"
        assert response.getheader("Set-Cookie").startswith("paper_language=ko;")
        assert '<html lang="ko">' in page

        payload = "password=test-password"
        connection.request(
            "POST",
            "/login?rd=%2Fp%2Fexample&lang=en",
            body=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response = connection.getresponse()
        response.read()
        cookies = response.headers.get_all("Set-Cookie")
        assert response.status == 303
        assert response.getheader("Location") == "/p/example"
        assert any(cookie.startswith("paper_session=") for cookie in cookies)
        assert any(cookie.startswith("paper_language=en;") for cookie in cookies)
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


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
    assert "paper_language" in source
    assert "Accept-Language" in source
    assert "Content-Language" in source
    assert ".env.password" in (ROOT / "infra/paper-workspace/.gitignore").read_text(encoding="utf-8")


def test_browser_requests_redirect_but_api_requests_stay_unauthorized() -> None:
    gate = (ROOT / "apps/paper_workspace/password_gate/server.py").read_text(encoding="utf-8")
    assert '"text/html" in self.headers.get("Accept", "")' in gate
    assert '"/_auth/login?" + urlencode' in gate
    assert "safe_redirect" in gate
    assert 'HTTPStatus.UNAUTHORIZED, {"authenticated": False}' in gate
