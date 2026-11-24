from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import sys
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import import_module
from pathlib import Path
from urllib.parse import parse_qs, urlencode

# Support package imports, standalone container entrypoints and file-based callers.
package = __package__
if not package:
    package_directory = Path(__file__).resolve().parent
    sys.path.insert(0, str(package_directory.parent))
    package = package_directory.name

accounts = import_module(".accounts", package)
rate_limit = import_module(".rate_limit", package)
BoundedHTTPServer = import_module(".password_gate_http", package).BoundedHTTPServer
render_page = import_module(".password_gate_rendering", package).render_page

LOGIN_BASE_DELAY = rate_limit.LOGIN_BASE_DELAY
LOGIN_FAILURE_WINDOW = rate_limit.LOGIN_FAILURE_WINDOW
LOGIN_FREE_FAILURES = rate_limit.LOGIN_FREE_FAILURES
LOGIN_MAX_DELAY = rate_limit.LOGIN_MAX_DELAY
LOGIN_MAX_TRACKED_IPS = rate_limit.LOGIN_MAX_TRACKED_IPS
FailureState = rate_limit.FailureState
LoginAttemptLimiter = rate_limit.LoginAttemptLimiter
bounded_float = rate_limit.bounded_float
bounded_int = rate_limit.bounded_int

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
        "rate_limited": "Too many sign-in attempts. Please wait before trying again.",
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
        "rate_limited": "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        "invalid_request": "로그인 요청이 올바르지 않습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
        "language_label": "언어",
    },
}
try:
    SESSION_MAX_AGE = max(300, min(2_592_000, int(os.environ.get("PAPER_SESSION_MAX_AGE", "2592000"))))
except ValueError:
    SESSION_MAX_AGE = 2_592_000


CLIENT_IP_HEADER = "X-Paper-Client-IP"
FAVICON_PATH = Path(os.environ.get("PAPER_FAVICON_PATH", "/app/favicon-64.png"))


def favicon_data_url(path: Path = FAVICON_PATH) -> str:
    try:
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError:
        return "/assets/paper-workspace-icon.png"
    return f"data:image/png;base64,{encoded}"


FAVICON_DATA_URL = favicon_data_url()


def logo_data_url(mode: str) -> str:
    """Embed the approved mark so the login page works before authentication."""
    name = f"paper-folio-{mode}.svg"
    paths = (Path("/app") / name, Path(__file__).resolve().parents[1] / "static" / "assets" / name)
    for path in paths:
        try:
            return "data:image/svg+xml;base64," + base64.b64encode(path.read_bytes()).decode("ascii")
        except OSError:
            continue
    return FAVICON_DATA_URL


def configuration_errors(password: str | None = None, session_secret: str | None = None) -> list[str]:
    access = PASSWORD if password is None else password
    secret = SESSION_SECRET if session_secret is None else session_secret
    errors: list[str] = []
    if accounts.REGISTRY:
        try:
            accounts.registry()
        except Exception:
            errors.append("invalid account registry")
    if not accounts.REGISTRY and (len(access) < 12 or access.startswith("replace-with-")):
        errors.append("access password must be at least 12 non-placeholder characters")
    if len(secret) < 32 or secret.startswith("replace-with-"):
        errors.append("session secret must be at least 32 random non-placeholder characters")
    if access and hmac.compare_digest(access.encode("utf-8"), secret.encode("utf-8")):
        errors.append("access password and session secret must be different")
    return errors


def parse_trusted_proxy_networks(
    value: str,
) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    """Parse explicit proxy CIDRs; invalid entries are ignored so header trust fails closed."""
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for item in value.split(","):
        try:
            networks.append(ipaddress.ip_network(item.strip(), strict=False))
        except ValueError:
            continue
    return tuple(networks)


TRUSTED_PROXY_NETWORKS = parse_trusted_proxy_networks(
    os.environ.get("PAPER_TRUSTED_PROXY_CIDRS", "")
)


def canonical_ip(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return ipaddress.ip_address(value.strip().split("%", 1)[0]).compressed
    except ValueError:
        return None


def client_ip(handler: BaseHTTPRequestHandler) -> str:
    """Resolve a rate-limit identity without trusting client-supplied forwarding chains.

    Caddy must overwrite X-Paper-Client-IP with its direct remote host, and its socket
    address must match PAPER_TRUSTED_PROXY_CIDRS. X-Forwarded-For is never consulted.
    """
    peer = canonical_ip(handler.client_address[0]) or "unknown"
    peer_address = ipaddress.ip_address(peer) if peer != "unknown" else None
    if peer_address is None or not any(
        peer_address in network for network in TRUSTED_PROXY_NETWORKS
    ):
        return peer
    values = handler.headers.get_all(CLIENT_IP_HEADER, [])
    if len(values) != 1 or "," in values[0]:
        return peer
    return canonical_ip(values[0]) or peer


LOGIN_LIMITER = LoginAttemptLimiter()


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
    return expires > current and hmac.compare_digest(provided.encode("utf-8"), signature(expires).encode("ascii"))


def issue_session(now: int | None = None) -> tuple[str, int]:
    current = int(time.time()) if now is None else now
    expires = current + SESSION_MAX_AGE
    return f"{expires}.{signature(expires)}", expires


def safe_redirect(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
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


def login_styles() -> str:
    """Inline shared styles; the bundled UI font is an allowlisted public asset."""
    directory = Path(__file__).resolve().parent
    static = directory.parent / "static"
    styles = []
    for name in ("theme.css", "login.css"):
        path = directory / name
        if not path.is_file():
            path = static / name
        css = path.read_text(encoding="utf-8")
        styles.append(css)
    return "\n".join(styles)


def render_login_page(language: str, redirect: str = "/", error_code: str = "") -> bytes:
    language = normalize_language(language) or "en"
    copy = dict(COPY[language])
    return render_page(
        language, redirect, error_code, copy, bool(accounts.REGISTRY),
        login_url, login_styles(), FAVICON_DATA_URL, logo_data_url("light"), logo_data_url("dark"),
    )


class Handler(BaseHTTPRequestHandler):
    def _account_request(self):
        try:
            data = accounts.registry()
        except Exception:
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "account configuration unavailable"})
            return
        name = accounts.session(data, self.headers.get('Cookie'), SESSION_SECRET)
        path = self.path.split('?', 1)[0]
        if not name:
            if path == '/verify' and 'text/html' in self.headers.get('Accept', ''):
                target = safe_redirect(self.headers.get('X-Forwarded-Uri', '/'))
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header('Location', login_url(target, 'ko'))
                self.send_header('Content-Length', '0'); self.end_headers()
            else:
                self._json(HTTPStatus.UNAUTHORIZED, {"authenticated": False})
            return
        if path == '/context.js':
            payload = json.dumps({'user': name, 'projects': accounts.memberships(data, name)}, ensure_ascii=True)
            body = ('window.PaperAccess=' + payload + ';').encode()
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body); return
        if path == '/me':
            self._json(HTTPStatus.OK, {'authenticated': True, 'user': name, 'projects': accounts.memberships(data, name)})
            return
        if path == '/catalog':
            try:
                self._json(HTTPStatus.OK, accounts.catalog(data, name))
            except Exception:
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {'error': 'catalog unavailable'})
            return
        # Public /_auth/verify is a session probe. Forward-auth always supplies URI.
        uri = self.headers.get('X-Forwarded-Uri', '/')
        method = self.headers.get('X-Forwarded-Method', 'GET')
        role = accounts.authorize(data, name, uri, method)
        if not role:
            self._json(HTTPStatus.FORBIDDEN, {'error': 'project access denied'})
            return
        if uri == '/' and 'text/html' in self.headers.get('Accept', ''):
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header('Location', '/' + name)
            self.send_header('Content-Length', '0'); self.end_headers(); return
        self.send_response(HTTPStatus.OK)
        self.send_header('X-Paper-Actor', name)
        self.send_header('X-Paper-Role', role)
        ids = {p['backup_id'] for p in data['projects'].values() if name in p['members']}
        self.send_header('X-Paper-Allowed-Projects', ','.join(sorted(ids)) or '-')
        self.send_header('Cache-Control', 'no-store')
        body = b'{"authenticated":true}'
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if accounts.REGISTRY and self.path.split('?', 1)[0] in ('/verify', '/me', '/catalog', '/context.js'):
            self._account_request()
            return
        if self.path.split('?', 1)[0] == '/context.js':
            body = b'window.PaperAccess=null;'
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'text/javascript')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body); return
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
            errors = configuration_errors()
            self._json(HTTPStatus.SERVICE_UNAVAILABLE if errors else HTTPStatus.OK, {"status": "configuration-error" if errors else "ok", "error_count": len(errors)})
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
        request_path = self.path.split("?", 1)[0]
        if request_path == "/logout":
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/_auth/login")
            self.send_header("Set-Cookie", "paper_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax")
            self.send_header("Set-Cookie", "rebuttal_session=; Max-Age=0; Path=/api/rebuttal/; HttpOnly; Secure; SameSite=Strict")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if request_path != "/login":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        identity = client_ip(self)
        query = parse_qs(self.path.partition("?")[2])
        query_language = query.get("lang", [None])[0]
        language = resolve_language(
            query_language, self.headers.get("Cookie"), self.headers.get("Accept-Language")
        )
        with LOGIN_LIMITER.attempt(identity) as retry_after:
            if retry_after:
                self.close_connection = True
                self._login_form(
                    "rate_limited",
                    redirect=safe_redirect(query.get("rd", ["/"])[0]),
                    language=language,
                    remember_language=normalize_language(query_language) is not None,
                    status=HTTPStatus.TOO_MANY_REQUESTS,
                    retry_after=retry_after,
                )
                return
            self._submit_login(identity, query, query_language, language)

    def _submit_login(self, identity, query, query_language, language):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 4096:
                raise ValueError("invalid login request")
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("incomplete login request")
            values = parse_qs(body.decode("utf-8"), keep_blank_values=True)
            supplied = values.get("password", [""])[0]
            redirect = safe_redirect(values.get("rd", query.get("rd", ["/"]))[0])
            name = values.get('username', [''])[0].strip()
            try:
                data = accounts.registry() if accounts.REGISTRY else None
            except Exception:
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {'error': 'account configuration unavailable'})
                return
            password_matches = accounts.authenticate(data, name, supplied) if data is not None else bool(PASSWORD) and hmac.compare_digest(supplied.encode("utf-8"), PASSWORD.encode("utf-8"))
            authenticated, retry_after = LOGIN_LIMITER.evaluate_attempt(
                identity,
                password_matches,
            )
            if not authenticated:
                self._login_form(
                    "rate_limited" if retry_after else "invalid_password",
                    redirect=redirect,
                    language=language,
                    remember_language=normalize_language(query_language) is not None,
                    status=HTTPStatus.TOO_MANY_REQUESTS if retry_after else HTTPStatus.OK,
                    retry_after=retry_after,
                )
                return
            if data is not None:
                token = accounts.issue(data, name, SESSION_SECRET, SESSION_MAX_AGE)
                if redirect == "/":
                    redirect = "/" + name
            else:
                token, _ = issue_session()
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", redirect)
            self.send_header(
                "Set-Cookie",
                f"paper_session={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax",
            )
            self.send_header("Set-Cookie", "rebuttal_session=; Max-Age=0; Path=/api/rebuttal/; HttpOnly; Secure; SameSite=Strict")
            self.send_header("Set-Cookie", language_cookie(language))
            self.send_header("Content-Length", "0")
            self.end_headers()
        except (UnicodeDecodeError, ValueError):
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
        status: HTTPStatus = HTTPStatus.OK,
        retry_after: int = 0,
    ) -> None:
        body = render_login_page(language, redirect, error_code)
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Language", normalize_language(language) or "en")
        if retry_after:
            self.send_header("Retry-After", str(retry_after))
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


def create_server(host: str = "0.0.0.0", port: int = 8079) -> ThreadingHTTPServer:
    return BoundedHTTPServer((host, port), Handler)


if __name__ == "__main__":
    errors = configuration_errors()
    if errors:
        raise SystemExit("password gate configuration is unsafe: " + "; ".join(errors))
    create_server().serve_forever()
