"""Project catalog and HTTP request routing."""
from __future__ import annotations

from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

if __package__:
    from .imports import ValidationError, SessionPool, digest, text
    from .state import MAX_REQUEST_BYTES, identifier, NotFound, Conflict, Forbidden, empty_state
    from .rebuttal_store import RebuttalStore
else:
    from imports import ValidationError, SessionPool, digest, text
    from state import MAX_REQUEST_BYTES, identifier, NotFound, Conflict, Forbidden, empty_state
    from rebuttal_store import RebuttalStore


class ProjectCatalog:
    def __init__(self, runtime_root):
        self.root = Path(runtime_root)

    def resolve(self, slug):
        identifier(slug)
        catalog = json.loads((self.root / 'projects/index.json').read_text())
        entry = next((e for e in catalog.get('projects', []) if e.get('slug') == slug), None)
        if entry is None:
            raise NotFound('project not found')
        path = self.root / 'project/project.json' if entry.get('source') == 'default' else self.root / 'projects' / slug / 'project.json'
        manifest = json.loads(path.read_text())
        return identifier(manifest.get('backup_id', manifest.get('id')))

    def manuscript(self, slug):
        identifier(slug)
        catalog = json.loads((self.root / 'projects/index.json').read_text())
        entry = next((e for e in catalog.get('projects', []) if e.get('slug') == slug), None)
        if entry is None: raise NotFound('project not found')
        root = (self.root / 'project' if entry.get('source') == 'default' else self.root / 'projects' / slug).resolve()
        manifest = json.loads((root / 'project.json').read_text())
        files = manifest.get('files', [])
        if not isinstance(files, list): raise ValidationError('논문 원문 목록을 읽을 수 없습니다.')
        paths = [item.get('path') for item in files if isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'].lower().endswith(('.tex', '.bib'))]
        entrypoint = manifest.get('entrypoint')
        if not paths or entrypoint not in paths: raise ValidationError('논문 원문을 찾을 수 없습니다.')
        result, total = [], 0
        for path in dict.fromkeys(paths):
            target = (root / path).resolve()
            if not target.is_relative_to(root) or not target.is_file(): raise ValidationError('논문 원문 파일을 읽을 수 없습니다.')
            try: content = target.read_text(encoding='utf-8')
            except (OSError, UnicodeError): raise ValidationError('논문 원문 파일을 읽을 수 없습니다.') from None
            total += len(content)
            if total > 500_000: raise ValidationError('논문 원문이 연결 분석 입력 한도를 초과합니다.')
            result.append({'path': path, 'text': content})
        return {'entrypoint': entrypoint, 'files': result}


class RebuttalHandler(BaseHTTPRequestHandler):
    store: RebuttalStore
    sessions = SessionPool()
    binding_key = secrets.token_bytes(32)
    catalog = None
    allowed_projects = None
    feature_projects = None
    enabled = False
    actor_mode = 'shared'
    shared_actor = 'Shared user'
    shared_scope = False

    def _actor(self):
        if self.actor_mode == 'proxy':
            actor = self.headers.get('X-Paper-Actor')
            role = self.headers.get('X-Paper-Role')
            if not actor or role not in {'owner', 'editor', 'viewer'} or self.headers.get('X-Paper-Allowed-Projects') is None:
                raise Forbidden('authenticated project access is required')
            return text(actor, 'actor', 120)
        return self.shared_actor

    def _project(self, slug):
        slug = identifier(urllib.parse.unquote(slug))
        project = self.catalog.resolve(slug) if self.catalog is not None else slug
        if self.allowed_projects is not None and slug not in self.allowed_projects and project not in self.allowed_projects:
            raise NotFound('project not found')
        if self.feature_projects and slug not in self.feature_projects and project not in self.feature_projects:
            raise NotFound('rebuttal is not enabled for this project')
        allowed = self.headers.get('X-Paper-Allowed-Projects')
        if allowed == '*':
            if not self.shared_scope or self.catalog is None and self.allowed_projects is None:
                raise Forbidden('shared project scope is disabled')
        elif allowed is not None and project not in set(allowed.split(',')) and slug not in set(allowed.split(',')):
            raise NotFound('project not found')
        return project

    def _cookie(self, create=False):
        cookie = SimpleCookie()
        try: cookie.load(self.headers.get('Cookie', ''))
        except Exception: cookie = SimpleCookie()
        item = cookie.get('rebuttal_session')
        if item and re.fullmatch(r'[a-f0-9]{64}', item.value): return item.value, False
        return (secrets.token_hex(32), True) if create else (None, False)

    def _session_binding(self, raw):
        if raw is None: return None
        cookie = SimpleCookie()
        try: cookie.load(self.headers.get('Cookie', ''))
        except Exception: cookie = SimpleCookie()
        auth = {name: value.value for name, value in cookie.items() if name == 'paper_session' or name.startswith('_oauth2_proxy')}
        material = json.dumps([raw, auth], sort_keys=True, separators=(',', ':')).encode()
        return hmac.new(self.binding_key, material, hashlib.sha256).hexdigest()

    def _body(self):
        try: size = int(self.headers.get('Content-Length', ''))
        except ValueError: raise ValidationError('invalid content length') from None
        if not 1 <= size <= MAX_REQUEST_BYTES:
            raise ValidationError('request is empty or too large')
        try: body = json.loads(self.rfile.read(size), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite JSON number')))
        except (ValueError, UnicodeDecodeError): raise ValidationError('invalid JSON') from None
        if not isinstance(body, dict): raise ValidationError('request must be an object')
        return body

    def _json(self, status, value, etag=None, cookie=None, clear_cookie=False):
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'private, no-cache' if etag else 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(encoded)))
        if etag: self.send_header('ETag', etag)
        if cookie:
            secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
            self.send_header('Set-Cookie', f'rebuttal_session={cookie}; HttpOnly; SameSite=Strict; Path=/api/rebuttal/; Max-Age=3600{secure}')
        if clear_cookie:
            self.send_header('Set-Cookie', 'rebuttal_session=; HttpOnly; SameSite=Strict; Path=/api/rebuttal/; Max-Age=0')
        self.end_headers(); self.wfile.write(encoded)

    def _handle(self):
        try:
            path = urllib.parse.urlsplit(self.path).path
            if path == '/health':
                healthy = self.store.workers_alive()
                if healthy:
                    try:
                        with self.store._connect() as db:
                            db.execute('SELECT 1')
                    except sqlite3.Error:
                        healthy = False
                self._json(200 if healthy else 503,
                           {'status': 'ok' if healthy else 'unhealthy', 'enabled': self.enabled})
                return
            match = re.fullmatch(r'(?:/api/rebuttal)?/projects/([^/]+)(/.*)', path)
            if not match: raise NotFound('not found')
            actor = self._actor()
            project = self._project(match[1]); route = match[2].rstrip('/')
            if not self.enabled:
                if self.command == 'GET' and route == '/state':
                    self._json(200, {**empty_state(), 'enabled': False}); return
                raise NotFound('rebuttal is disabled')
            if self.command == 'GET':
                if route == '/state':
                    state = self.store.state(project)
                    etag = f'"rebuttal-{state["revision"]}-{digest(state["jobs"])[:16]}"'
                    if self.headers.get('If-None-Match') == etag:
                        self.send_response(304); self.send_header('ETag', etag); self.send_header('Content-Length', '0'); self.end_headers(); return
                    self._json(200, state, etag=etag); return
                if route == '/snapshot': self._json(200, self.store.snapshot(project)); return
                job_match = re.fullmatch(r'/rounds/([^/]+)/analyses/([^/]+)', route)
                if job_match:
                    self._json(200, self.store.job(project, *(identifier(value) for value in job_match.groups()))); return
                versions_match = re.fullmatch(r'/rounds/([^/]+)/documents/([^/]+)/versions', route)
                if versions_match:
                    self._json(200, self.store.response_versions(project, *versions_match.groups())); return
                raise NotFound('not found')
            export = self.command == 'POST' and re.fullmatch(r'/rounds/[^/]+/exports', route)
            if self.actor_mode == 'proxy' and self.headers.get('X-Paper-Role') not in {'owner', 'editor'} and not export:
                raise Forbidden('project editor role is required')
            origin = self.headers.get('Origin')
            if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get('Host'):
                raise Forbidden('cross-origin mutation is forbidden')
            # Session endpoints never persist credential-bearing request bodies.
            if route == '/openreview/session' and self.command == 'DELETE':
                session_id, _ = self._cookie()
                self.sessions.disconnect(actor, self._session_binding(session_id))
                response = self.store.state(project); response['result'] = {'connected': False}
                self._json(200, response, clear_cookie=True); return
            body = self._body()
            versions_match = re.fullmatch(r'/rounds/([^/]+)/documents/([^/]+)/versions', route)
            if self.command == 'POST' and versions_match:
                self._json(200, self.store.save_response_version(project, *versions_match.groups(), body, actor)); return
            if route in {'/openreview/session', '/openreview/session/mfa'} and self.command == 'POST':
                session_id, _ = self._cookie(create=True)
                if route.endswith('/mfa'):
                    result = self.sessions.mfa(actor, self._session_binding(session_id), body.get('challenge_id'), body.get('method'), body.get('code'))
                else:
                    result = self.sessions.connect(actor, self._session_binding(session_id), body.get('username'), body.get('password'), body.get('api_version', 2))
                response = self.store.state(project); response['result'] = result
                self._json(200, response, cookie=session_id); return
            if route == '/rounds' and self.command == 'POST': response = self.store.create_round(project, body)
            elif route == '/restore' and self.command == 'POST': response = self.store.restore(project, body, actor)
            else:
                parts = route.strip('/').split('/')
                if len(parts) < 2 or parts[0] != 'rounds': raise NotFound('not found')
                round_id = identifier(parts[1])
                action = parts[2] if len(parts) >= 3 else None
                if len(parts) == 2 and self.command == 'PUT': response = self.store.update_round(project, round_id, body, actor)
                elif self.command != 'POST': raise NotFound('not found')
                elif len(parts) == 3 and action == 'documents': response = self.store.create_document(project, round_id, body)
                elif len(parts) == 3 and action == 'imports':
                    session_id, _ = self._cookie()
                    response = self.store.stage_import(project, round_id, body, self.sessions, actor, self._session_binding(session_id))
                elif len(parts) == 5 and action == 'imports' and parts[4] == 'commit': response = self.store.commit_import(project, round_id, identifier(parts[3]), body, actor)
                elif len(parts) == 5 and action == 'imports' and parts[4] == 'reparse': response = self.store.reparse_import(project, round_id, identifier(parts[3]), body)
                elif len(parts) == 3 and action == 'rules': response = self.store.add_rules(project, round_id, body, actor)
                elif len(parts) == 5 and action == 'rules' and parts[4] == 'apply': response = self.store.apply_rules(project, round_id, identifier(parts[3]), body, actor)
                elif len(parts) == 3 and action == 'analyses':
                    manuscript = self.catalog.manuscript(urllib.parse.unquote(match[1])) if body.get('task') == 'connect' and self.catalog else None
                    response = self.store.queue(project, round_id, body, actor, manuscript=manuscript)
                elif len(parts) == 5 and action == 'analyses' and parts[4] in {'cancel', 'retry'}: response = self.store.job_action(project, round_id, identifier(parts[3]), body, parts[4])
                elif len(parts) == 3 and action == 'exports': response = self.store.export(project, round_id, body)
                elif len(parts) == 3 and action == 'submissions': response = self.store.submit(project, round_id, body, actor)
                else: raise NotFound('not found')
            self._json(200, response)
        except Conflict as exc: self._json(409, {'error': str(exc), 'revision': exc.revision})
        except Forbidden as exc: self._json(403, {'error': str(exc)})
        except NotFound as exc: self._json(404, {'error': str(exc)})
        except ValidationError as exc: self._json(400, {'error': str(exc)})
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError): self._json(400, {'error': 'invalid request structure'})
        except Exception: self._json(500, {'error': 'internal rebuttal error'})

    do_GET = do_POST = do_PUT = do_DELETE = _handle

    def log_message(self, *_):
        pass
