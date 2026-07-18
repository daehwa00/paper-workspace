from __future__ import annotations

import base64
import hashlib
import http.client
import importlib.util
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

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


def test_password_gate_rejects_weak_or_placeholder_configuration() -> None:
    gate = load_gate()

    assert gate.configuration_errors("short", "s" * 32)
    assert gate.configuration_errors("replace-with-password", "x" * 32)
    assert gate.configuration_errors("a-strong-password", "replace-with-a-long-random-secret")
    assert gate.configuration_errors("same-secret-value-that-is-long-enough", "same-secret-value-that-is-long-enough")
    assert gate.configuration_errors("a-strong-password", "x" * 32) == []


def test_login_limiter_applies_bounded_exponential_cooldowns_and_resets() -> None:
    gate = load_gate()
    limiter = gate.LoginAttemptLimiter(
        free_failures=1,
        base_delay=2,
        max_delay=8,
        failure_window=60,
        max_entries=3,
    )

    assert limiter.record_failure("client-a", now=0) == 0
    assert limiter.record_failure("client-a", now=1) == 2
    assert limiter.retry_after("client-a", now=1.1) == 2
    assert limiter.retry_after("client-a", now=3) == 0
    assert limiter.record_failure("client-a", now=3) == 4
    assert limiter.record_failure("client-a", now=7) == 8
    assert limiter.record_failure("client-a", now=15) == 8

    limiter.record_success("client-a")
    assert limiter.retry_after("client-a", now=15) == 0
    assert limiter.record_failure("client-a", now=16) == 0


def test_login_limiter_is_thread_safe_and_bounds_retained_clients() -> None:
    gate = load_gate()
    limiter = gate.LoginAttemptLimiter(
        free_failures=1,
        base_delay=1,
        max_delay=2,
        failure_window=60,
        max_entries=3,
    )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(lambda _: limiter.evaluate_attempt("shared", False, now=1), range(100))
        )
    assert results.count((False, 0)) == 1
    assert results.count((False, 1)) == 99
    assert limiter.retry_after("shared", now=1) == 1

    bounded = gate.LoginAttemptLimiter(
        free_failures=99,
        base_delay=1,
        max_delay=2,
        failure_window=60,
        max_entries=3,
    )
    bounded.record_failure("shared", now=1)
    for index in range(4):
        bounded.record_failure(f"client-{index}", now=1)
    assert bounded.retry_after("shared", now=1) == 0

    expiring = gate.LoginAttemptLimiter(
        free_failures=0,
        base_delay=1,
        max_delay=2,
        failure_window=60,
        max_entries=3,
    )
    expiring.record_failure("old", now=1)
    assert expiring.retry_after("old", now=1) == 1
    assert expiring.retry_after("old", now=100) == 0


def test_client_ip_only_trusts_dedicated_header_from_configured_proxy(monkeypatch) -> None:
    gate = load_gate()
    headers = Message()
    headers.add_header("X-Forwarded-For", "198.51.100.4")
    headers.add_header("X-Paper-Client-IP", "203.0.113.8")
    handler = SimpleNamespace(client_address=("127.0.0.1", 1234), headers=headers)

    monkeypatch.setattr(gate, "TRUSTED_PROXY_NETWORKS", ())
    assert gate.client_ip(handler) == "127.0.0.1"

    monkeypatch.setattr(
        gate,
        "TRUSTED_PROXY_NETWORKS",
        gate.parse_trusted_proxy_networks("127.0.0.1/32,invalid-entry"),
    )
    assert gate.client_ip(handler) == "203.0.113.8"

    headers.add_header("X-Paper-Client-IP", "192.0.2.9")
    assert gate.client_ip(handler) == "127.0.0.1"


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


def test_login_page_uses_an_inline_character_icon_when_packaged(tmp_path, monkeypatch) -> None:
    gate = load_gate()
    icon = tmp_path / "favicon.png"
    icon.write_bytes(b"\x89PNG\r\n\x1a\ncharacter-icon")
    data_url = gate.favicon_data_url(icon)
    monkeypatch.setattr(gate, "FAVICON_DATA_URL", data_url)

    page = gate.render_login_page("en").decode()

    assert data_url.startswith("data:image/png;base64,")
    assert 'href="/assets/paper-workspace-icon.png"' in page
    assert f'href="{data_url}"' in page


def test_password_gate_image_packages_the_character_icon() -> None:
    dockerfile = (ROOT / "apps/paper_workspace/password_gate/Dockerfile").read_text(encoding="utf-8")

    assert "apps/paper_workspace/static/assets/favicon-64.png /app/favicon-64.png" in dockerfile


def test_password_login_theme_bootstrap_is_allowed_by_its_exact_csp_hash() -> None:
    gate = load_gate()
    page = gate.render_login_page("en").decode()
    script = re.search(r"<script>(.*?)</script>", page)
    assert script is not None
    digest = base64.b64encode(hashlib.sha256(script.group(1).encode()).digest()).decode()
    caddy = (ROOT / "infra/paper-workspace/Caddyfile.password").read_text(encoding="utf-8")

    assert f"'sha256-{digest}'" in caddy
    assert "script-src 'self' 'unsafe-inline'" not in caddy


def test_redirect_target_rejects_response_splitting_characters() -> None:
    gate = load_gate()

    assert gate.safe_redirect("/p/example?tab=main") == "/p/example?tab=main"
    assert gate.safe_redirect("/p/example\r\nX-Injected: yes") == "/"
    assert gate.safe_redirect("/p/example\x7fhidden") == "/"
    assert gate.safe_redirect("//attacker.example/path") == "/"


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


def test_login_handler_throttles_by_peer_and_emits_retry_after(monkeypatch) -> None:
    gate = load_gate()
    monkeypatch.setattr(gate, "PASSWORD", "test-password")
    monkeypatch.setattr(gate, "SESSION_SECRET", "test-session-secret")
    monkeypatch.setattr(gate, "TRUSTED_PROXY_NETWORKS", ())
    limiter = gate.LoginAttemptLimiter(
        free_failures=1,
        base_delay=60,
        max_delay=60,
        failure_window=120,
        max_entries=10,
    )
    monkeypatch.setattr(gate, "LOGIN_LIMITER", limiter)
    server = gate.ThreadingHTTPServer(("127.0.0.1", 0), gate.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)

    def submit(password: str, forwarded_for: str) -> http.client.HTTPResponse:
        connection.request(
            "POST",
            "/login?lang=en",
            body=f"password={password}",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Forwarded-For": forwarded_for,
                "X-Paper-Client-IP": forwarded_for,
            },
        )
        return connection.getresponse()

    try:
        response = submit("wrong", "198.51.100.1")
        response.read()
        assert response.status == 200

        response = submit("still-wrong", "198.51.100.2")
        page = response.read().decode()
        assert response.status == 429
        assert response.getheader("Retry-After") == "60"
        assert "Too many sign-in attempts" in page

        response = submit("test-password", "198.51.100.3")
        response.read()
        assert response.status == 429

        limiter.record_success("127.0.0.1")
        response = submit("test-password", "198.51.100.4")
        response.read()
        assert response.status == 303
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


def test_logout_clears_the_session_cookie(monkeypatch) -> None:
    gate = load_gate()
    monkeypatch.setattr(gate, "PASSWORD", "a-strong-password")
    monkeypatch.setattr(gate, "SESSION_SECRET", "x" * 32)
    server = gate.ThreadingHTTPServer(("127.0.0.1", 0), gate.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
    try:
        connection.request("POST", "/logout")
        response = connection.getresponse()
        response.read()
        assert response.status == 303
        assert response.getheader("Location") == "/_auth/login"
        assert "paper_session=; Max-Age=0" in response.getheader("Set-Cookie")
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_edge_rejects_unsafe_requests_with_a_foreign_origin() -> None:
    for name in ("Caddyfile", "Caddyfile.auth", "Caddyfile.password"):
        source = (ROOT / "infra/paper-workspace" / name).read_text(encoding="utf-8")
        assert "@foreign_unsafe" in source
        assert "method POST PUT PATCH DELETE" in source
        assert "not header Origin https://{$PAPER_DOMAIN}" in source
        assert "handle @foreign_unsafe {" in source
        assert "respond 403" in source
        assert source.index("handle @foreign_unsafe {") < source.index("handle /__client_error")
