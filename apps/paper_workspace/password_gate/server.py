from __future__ import annotations

import hashlib
import hmac
import os
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs


PASSWORD = os.environ.get("PAPER_ACCESS_PASSWORD", "")
SESSION_SECRET = os.environ.get("PAPER_SESSION_SECRET", "")
try:
    SESSION_MAX_AGE = max(300, min(2_592_000, int(os.environ.get("PAPER_SESSION_MAX_AGE", "2592000"))))
except ValueError:
    SESSION_MAX_AGE = 2_592_000


def signature(expires: int) -> str:
    return hmac.new(SESSION_SECRET.encode(), str(expires).encode(), hashlib.sha256).hexdigest()


def valid_session(cookie_header: str | None, now: int | None = None) -> bool:
    if not SESSION_SECRET or not cookie_header:
        return False
    cookies = SimpleCookie()
    cookies.load(cookie_header)
    morsel = cookies.get("paper_session")
    if morsel is None:
        return False
    try:
        expires_text, provided = morsel.value.split(".", 1)
        expires = int(expires_text)
    except (TypeError, ValueError):
        return False
    current = int(time.time()) if now is None else now
    return expires > current and hmac.compare_digest(provided, signature(expires))


def issue_session(now: int | None = None) -> tuple[str, int]:
    current = int(time.time()) if now is None else now
    expires = current + SESSION_MAX_AGE
    return f"{expires}.{signature(expires)}", expires


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/verify":
            if valid_session(self.headers.get("Cookie")):
                self._json(HTTPStatus.OK, {"authenticated": True})
            elif "text/html" in self.headers.get("Accept", ""):
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", "/_auth/login")
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._json(HTTPStatus.UNAUTHORIZED, {"authenticated": False})
            return
        if self.path.split("?", 1)[0] == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        if self.path.split("?", 1)[0] == "/login":
            self._login_form()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/login":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 4096:
                raise ValueError("invalid login request")
            values = parse_qs(self.rfile.read(size).decode("utf-8"), keep_blank_values=True)
            supplied = values.get("password", [""])[0]
            if not PASSWORD or not hmac.compare_digest(supplied, PASSWORD):
                self._login_form("비밀번호가 올바르지 않습니다.")
                return
            token, _ = issue_session()
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/")
            self.send_header(
                "Set-Cookie",
                f"paper_session={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax",
            )
            self.send_header("Content-Length", "0")
            self.end_headers()
        except (UnicodeDecodeError, ValueError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid login request"})

    def _login_form(self, error: str = "") -> None:
        message = f"<p class=error>{error}</p>" if error else ""
        body = f"""<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paper Workspace 로그인</title><style>body{{margin:0;display:grid;place-items:center;min-height:100vh;background:#f2f4f7;font:15px system-ui,sans-serif;color:#101828}}main{{width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #e4e7ec;border-radius:16px;background:#fff;box-shadow:0 20px 50px #1018281c}}h1{{margin:0 0 8px;font-size:22px}}p{{color:#667085}}label{{display:grid;gap:8px;margin-top:22px;font-weight:600}}input{{box-sizing:border-box;padding:12px;border:1px solid #b2ccff;border-radius:8px;font:inherit}}button{{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:#2457d6;color:#fff;font:700 15px inherit;cursor:pointer}}.error{{color:#d92d20;font-size:13px}}</style><main><h1>Paper Workspace</h1><p>연구실 작업 공간에 들어가려면 비밀번호를 입력하세요.</p>{message}<form method="post" action="/_auth/login"><label>접속 비밀번호<input name="password" type="password" autocomplete="current-password" autofocus required></label><button type="submit">계속</button></form></main>""".encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: HTTPStatus, payload: dict[str, bool]) -> None:
        body = str(payload).replace("'", '"').encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8079), Handler).serve_forever()
