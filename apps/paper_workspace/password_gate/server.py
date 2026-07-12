from __future__ import annotations

import hashlib
import hmac
import html
import json
import os
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode


PASSWORD = os.environ.get("PAPER_ACCESS_PASSWORD", "")
SESSION_SECRET = os.environ.get("PAPER_SESSION_SECRET", "")
LANGUAGE_MAX_AGE = 31_536_000
SUPPORTED_LANGUAGES = ("en", "ko")
COPY = {
    "en": {
        "title": "Sign in · Paper Workspace",
        "eyebrow": "LAB PAPER MANAGEMENT",
        "heading": "Paper Workspace",
        "description": "Enter the shared access password to open your lab's paper workspace.",
        "password_label": "Access password",
        "submit": "Continue to workspace",
        "invalid_password": "The password is incorrect. Please try again.",
        "invalid_request": "The login request is invalid. Please reload the page and try again.",
        "language_label": "Language",
    },
    "ko": {
        "title": "로그인 · Paper Workspace",
        "eyebrow": "연구실 논문 관리",
        "heading": "Paper Workspace",
        "description": "공유 연구실 논문 작업공간에 들어가려면 접속 비밀번호를 입력하세요.",
        "password_label": "접속 비밀번호",
        "submit": "작업공간으로 계속",
        "invalid_password": "비밀번호가 올바르지 않습니다. 다시 시도해 주세요.",
        "invalid_request": "로그인 요청이 올바르지 않습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
        "language_label": "언어",
    },
}
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


def normalize_language(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    language = value.strip().lower().replace("_", "-").split("-", 1)[0]
    return language if language in SUPPORTED_LANGUAGES else None


def cookie_language(cookie_header: str | None) -> str | None:
    if not cookie_header:
        return None
    cookies = SimpleCookie()
    try:
        cookies.load(cookie_header)
    except Exception:  # malformed preference cookies must not block login
        return None
    morsel = cookies.get("paper_language")
    return normalize_language(morsel.value) if morsel else None


def accepted_language(header: str | None) -> str | None:
    """Return the highest-priority supported language from Accept-Language."""
    candidates: list[tuple[float, int, str]] = []
    for index, item in enumerate((header or "").split(",")):
        parts = [part.strip() for part in item.split(";")]
        language = normalize_language(parts[0])
        if not language:
            continue
        quality = 1.0
        for parameter in parts[1:]:
            if parameter.lower().startswith("q="):
                try:
                    quality = float(parameter[2:])
                except ValueError:
                    quality = 0.0
        if quality > 0:
            candidates.append((quality, -index, language))
    return max(candidates)[2] if candidates else None


def resolve_language(
    query_language: object = None,
    cookie_header: str | None = None,
    accept_language: str | None = None,
) -> str:
    """Resolve `?lang`, then cookie, then browser preference, with English fallback."""
    return (
        normalize_language(query_language)
        or cookie_language(cookie_header)
        or accepted_language(accept_language)
        or "en"
    )


def language_cookie(language: str) -> str:
    normalized = normalize_language(language) or "en"
    return (
        f"paper_language={normalized}; Max-Age={LANGUAGE_MAX_AGE}; "
        "Path=/; Secure; SameSite=Lax"
    )


def login_url(redirect: str, language: str) -> str:
    return "/_auth/login?" + urlencode({"rd": safe_redirect(redirect), "lang": language})


def render_login_page(language: str, redirect: str = "/", error_code: str = "") -> bytes:
    language = normalize_language(language) or "en"
    copy = COPY[language]
    error = copy.get(error_code, "")
    message = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    action = html.escape(login_url(redirect, language), quote=True)
    english_url = html.escape(login_url(redirect, "en"), quote=True)
    korean_url = html.escape(login_url(redirect, "ko"), quote=True)
    body = f"""<!doctype html><html lang="{language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#101828"><script>try{{const t=localStorage.getItem('paper-workspace-theme')||'system',d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.dataset.colorScheme=d?'dark':'light'}}catch(_){{}}</script><link rel="icon" href="/favicon.ico"><title>{html.escape(copy['title'])}</title><style>*{{box-sizing:border-box}}:root{{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#101828;background:#f2f4f7}}body{{margin:0;display:grid;min-width:320px;min-height:100dvh;place-items:center;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:linear-gradient(145deg,#f8fafc,#eef2f7)}}main{{width:min(380px,100%);padding:30px;border:1px solid #e4e7ec;border-radius:18px;background:#fff;box-shadow:0 22px 60px #1018281a}}header{{display:flex;align-items:center;gap:12px;margin-bottom:22px}}.mark{{display:grid;width:44px;height:44px;place-items:center;border-radius:12px;background:#101828;color:#fff;font-size:21px}}.eyebrow{{margin:0 0 3px;color:#667085;font-size:11px;font-weight:800;letter-spacing:.1em}}h1{{margin:0;font-size:23px;letter-spacing:-.035em}}p{{margin:0;color:#667085;font-size:14px;line-height:1.55}}.language{{display:flex;justify-content:flex-end;align-items:center;gap:7px;margin:-4px 0 18px;font-size:12px}}.language a{{color:#475467;text-decoration:none}}.language a[aria-current=true]{{color:#2457d6;font-weight:800}}.language span{{color:#d0d5dd}}label{{display:grid;gap:8px;margin-top:24px;color:#344054;font-size:13px;font-weight:700}}input{{width:100%;min-height:48px;padding:12px 13px;border:1px solid #b2ccff;border-radius:10px;background:#fff;color:#101828;font:16px inherit;outline:0;transition:border-color 120ms ease,box-shadow 120ms ease}}input:focus{{border-color:#4f7cff;box-shadow:0 0 0 4px #4f7cff1a}}button{{width:100%;min-height:48px;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#2457d6;color:#fff;font:700 15px inherit;cursor:pointer;transition:background-color 120ms ease,transform 120ms ease}}button:hover{{background:#1745bb}}button:active{{transform:scale(.98)}}button:focus-visible,a:focus-visible{{outline:3px solid #84adff;outline-offset:2px}}.error{{margin:16px 0 0;padding:9px 10px;border-radius:8px;background:#fef3f2;color:#b42318;font-size:13px}}html[data-color-scheme=dark]{{color-scheme:dark;background:#0b1220}}html[data-color-scheme=dark] body{{background:linear-gradient(145deg,#0b1220,#101a2b)}}html[data-color-scheme=dark] main{{border-color:#2a3850;background:#111a2b;box-shadow:0 22px 60px #0008}}html[data-color-scheme=dark] h1{{color:#f5f8ff}}html[data-color-scheme=dark] p,html[data-color-scheme=dark] .eyebrow,html[data-color-scheme=dark] .language a{{color:#a8b5c9}}html[data-color-scheme=dark] .language a[aria-current=true]{{color:#84adff}}html[data-color-scheme=dark] label{{color:#dbe5f5}}html[data-color-scheme=dark] input{{border-color:#365f9f;background:#182235;color:#f5f8ff}}@media(prefers-reduced-motion:reduce){{input,button{{transition:none}}button:active{{transform:none}}}}@media(prefers-contrast:more){{main,input{{border-color:#667085}}}}</style></head><body><main><nav class="language" aria-label="{html.escape(copy['language_label'])}"><a href="{english_url}" hreflang="en" lang="en" aria-current="{'true' if language == 'en' else 'false'}">English</a><span aria-hidden="true">·</span><a href="{korean_url}" hreflang="ko" lang="ko" aria-current="{'true' if language == 'ko' else 'false'}">한국어</a></nav><header><span class="mark" aria-hidden="true">✎</span><span><p class="eyebrow">{html.escape(copy['eyebrow'])}</p><h1>{html.escape(copy['heading'])}</h1></span></header><p>{html.escape(copy['description'])}</p>{message}<form method="post" action="{action}"><label>{html.escape(copy['password_label'])}<input name="password" type="password" autocomplete="current-password" autofocus required></label><button type="submit">{html.escape(copy['submit'])}</button></form></main></body></html>"""
    return body.encode("utf-8")


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
            query_language = query.get("lang", [None])[0]
            language = resolve_language(
                query_language,
                self.headers.get("Cookie"),
                self.headers.get("Accept-Language"),
            )
            self._login_form(
                redirect=safe_redirect(query.get("rd", ["/"])[0]),
                language=language,
                remember_language=normalize_language(query_language) is not None,
            )
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
            query_language = query.get("lang", [None])[0]
            language = resolve_language(
                query_language,
                self.headers.get("Cookie"),
                self.headers.get("Accept-Language"),
            )
            if not PASSWORD or not hmac.compare_digest(supplied, PASSWORD):
                self._login_form(
                    "invalid_password",
                    redirect=redirect,
                    language=language,
                    remember_language=normalize_language(query_language) is not None,
                )
                return
            token, _ = issue_session()
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", redirect)
            self.send_header(
                "Set-Cookie",
                f"paper_session={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax",
            )
            self.send_header("Set-Cookie", language_cookie(language))
            self.send_header("Content-Length", "0")
            self.end_headers()
        except (UnicodeDecodeError, ValueError):
            query = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            language = resolve_language(
                query.get("lang", [None])[0],
                self.headers.get("Cookie"),
                self.headers.get("Accept-Language"),
            )
            self._json(
                HTTPStatus.BAD_REQUEST,
                {
                    "error": COPY[language]["invalid_request"],
                    "error_code": "invalid_login_request",
                },
            )

    def _login_form(
        self,
        error_code: str = "",
        redirect: str = "/",
        language: str = "en",
        remember_language: bool = False,
    ) -> None:
        body = render_login_page(language, redirect, error_code)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Language", normalize_language(language) or "en")
        if remember_language:
            self.send_header("Set-Cookie", language_cookie(language))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
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
