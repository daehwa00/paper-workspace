from __future__ import annotations

import hashlib
import hmac
import os
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode


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


def safe_redirect(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    return value[:2048]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/verify":
            if valid_session(self.headers.get("Cookie")):
                self._json(HTTPStatus.OK, {"authenticated": True})
            elif "text/html" in self.headers.get("Accept", ""):
                target = safe_redirect(self.headers.get("X-Forwarded-Uri", "/"))
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", f"/_auth/login?{urlencode({'rd': target})}")
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._json(HTTPStatus.UNAUTHORIZED, {"authenticated": False})
            return
        if self.path.split("?", 1)[0] == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        if self.path.split("?", 1)[0] == "/login":
            query = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            self._login_form(redirect=safe_redirect(query.get("rd", ["/"])[0]))
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
            query = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            redirect = safe_redirect(values.get("rd", query.get("rd", ["/"]))[0])
            if not PASSWORD or not hmac.compare_digest(supplied, PASSWORD):
                self._login_form("비밀번호가 올바르지 않습니다.", redirect=redirect)
                return
            token, _ = issue_session()
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", redirect)
            self.send_header(
                "Set-Cookie",
                f"paper_session={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax",
            )
            self.send_header("Content-Length", "0")
            self.end_headers()
        except (UnicodeDecodeError, ValueError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid login request"})

    def _login_form(self, error: str = "", redirect: str = "/") -> None:
        message = f"<p class=error>{error}</p>" if error else ""
        action = "/_auth/login?" + urlencode({"rd": safe_redirect(redirect)})
        body = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#101828"><script>try{{const t=localStorage.getItem('paper-workspace-theme')||'system',d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.dataset.colorScheme=d?'dark':'light'}}catch(_){{}}</script><link rel="icon" href="/favicon.ico"><title>Paper Workspace 로그인</title><style>*{{box-sizing:border-box}}:root{{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#101828;background:#f2f4f7}}body{{margin:0;display:grid;min-width:320px;min-height:100dvh;place-items:center;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:linear-gradient(145deg,#f8fafc,#eef2f7)}}main{{width:min(380px,100%);padding:30px;border:1px solid #e4e7ec;border-radius:18px;background:#fff;box-shadow:0 22px 60px #1018281a}}header{{display:flex;align-items:center;gap:12px;margin-bottom:22px}}.mark{{display:grid;width:44px;height:44px;place-items:center;border-radius:12px;background:#101828;color:#fff;font-size:21px}}.eyebrow{{margin:0 0 3px;color:#667085;font-size:11px;font-weight:800;letter-spacing:.1em}}h1{{margin:0;font-size:23px;letter-spacing:-.035em}}p{{margin:0;color:#667085;font-size:14px;line-height:1.55}}label{{display:grid;gap:8px;margin-top:24px;color:#344054;font-size:13px;font-weight:700}}input{{width:100%;min-height:48px;padding:12px 13px;border:1px solid #b2ccff;border-radius:10px;background:#fff;color:#101828;font:16px inherit;outline:0;transition:border-color 120ms ease,box-shadow 120ms ease}}input:focus{{border-color:#4f7cff;box-shadow:0 0 0 4px #4f7cff1a}}button{{width:100%;min-height:48px;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#2457d6;color:#fff;font:700 15px inherit;cursor:pointer;transition:background-color 120ms ease,transform 120ms ease}}button:hover{{background:#1745bb}}button:active{{transform:scale(.98)}}button:focus-visible{{outline:3px solid #84adff;outline-offset:2px}}.error{{margin:0 0 14px;padding:9px 10px;border-radius:8px;background:#fef3f2;color:#b42318;font-size:13px}}html[data-color-scheme=dark]{{color-scheme:dark;background:#0b1220}}html[data-color-scheme=dark] body{{background:linear-gradient(145deg,#0b1220,#101a2b)}}html[data-color-scheme=dark] main{{border-color:#2a3850;background:#111a2b;box-shadow:0 22px 60px #0008}}html[data-color-scheme=dark] h1{{color:#f5f8ff}}html[data-color-scheme=dark] p,html[data-color-scheme=dark] .eyebrow{{color:#a8b5c9}}html[data-color-scheme=dark] label{{color:#dbe5f5}}html[data-color-scheme=dark] input{{border-color:#365f9f;background:#182235;color:#f5f8ff}}@media(prefers-reduced-motion:reduce){{input,button{{transition:none}}button:active{{transform:none}}}}@media(prefers-contrast:more){{main,input{{border-color:#667085}}}}</style></head><body><main><header><span class="mark" aria-hidden="true">✎</span><span><p class="eyebrow">연구실 논문 관리</p><h1>Paper Workspace</h1></span></header><p>공유 연구실 논문 작업공간에 들어가려면 접속 비밀번호를 입력하세요.</p>{message}<form method="post" action="{action}"><label>접속 비밀번호<input name="password" type="password" autocomplete="current-password" autofocus required></label><button type="submit">작업공간으로 계속</button></form></main></body></html>""".encode("utf-8")
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
