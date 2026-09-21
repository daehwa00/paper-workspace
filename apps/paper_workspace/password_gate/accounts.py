"""Private account registry and deny-by-default project authorization."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
import re
import time
import threading
HASH_LOCK = threading.Lock()
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import unquote, urlsplit

SLUG = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')
REGISTRY = os.environ.get('PAPER_ACCOUNTS_FILE', '')
CATALOG = os.environ.get('PAPER_ACCOUNT_CATALOG', '')


def registry():
    data = json.loads(Path(REGISTRY).read_text())
    if not isinstance(data.get('users'), dict) or not isinstance(data.get('projects'), dict):
        raise ValueError('invalid account registry')
    for name, user in data['users'].items():
        if not SLUG.fullmatch(name) or not isinstance(user.get('password_hash'), str):
            raise ValueError('invalid account')
    backup_ids = [p.get('backup_id') for p in data['projects'].values()]
    if len(set(backup_ids)) != len(backup_ids): raise ValueError('duplicate backup identity')
    for slug, project in data['projects'].items():
        if not SLUG.fullmatch(slug) or not SLUG.fullmatch(project.get('backup_id', '')):
            raise ValueError('invalid project')
        if any(name not in data['users'] or role not in ('owner', 'editor', 'viewer') for name, role in project['members'].items()):
            raise ValueError('invalid project membership')
    return data


def password_hash(password, salt=None):
    salt = salt or os.urandom(16).hex()
    with HASH_LOCK:
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f'scrypt${salt}${digest}'


def authenticate(data, name, password):
    user = data['users'].get(name, {})
    encoded = user.get('password_hash', 'scrypt$' + '00'*16 + '$' + '00'*64)
    try:
        kind, salt, digest = encoded.split('$')
        matched = kind == 'scrypt' and hmac.compare_digest(password_hash(password, salt), encoded)
    except (ValueError, TypeError):
        matched = False
    return bool(matched and user and not user.get('disabled'))


def issue(data, name, secret, max_age, now=None):
    payload = {'user': name, 'expires': int(time.time() if now is None else now) + max_age,
               'version': hashlib.sha256(data['users'][name]['password_hash'].encode()).hexdigest()}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':')).encode()).decode().rstrip('=')
    return body + '.' + hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()


def session(data, cookie, secret, now=None):
    try:
        cookies = SimpleCookie(); cookies.load(cookie or '')
        body, signature = cookies['paper_session'].value.split('.')
        if not hmac.compare_digest(signature, hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
        user = data['users'].get(payload['user'])
        if not user or user.get('disabled') or payload['expires'] <= (time.time() if now is None else now):
            return None
        if payload['version'] != hashlib.sha256(user['password_hash'].encode()).hexdigest():
            return None
        return payload['user']
    except Exception:
        return None


def memberships(data, name):
    return {slug: p['members'][name] for slug, p in data['projects'].items() if name in p['members']}


def authorize(data, name, uri, method):
    """Return a project role or None. Never infer authority from Referer or client headers."""
    path = unquote(urlsplit(uri).path)
    if any(ord(c) < 32 or ord(c) == 127 for c in path) or '//' in path or '%' in path or '\\' in path or any(part in ('.', '..') for part in path.split('/')):
        return None
    roles = memberships(data, name)
    if path in ('/', '/' + name, '/' + name + '/', '/hub.html', '/projects/index.json', '/api/backups/activity'):
        return 'member' if method in ('GET', 'HEAD') else None
    slug = None
    match = re.fullmatch(r'/p/([^/]+)(?:/project/.*|/)?', path)
    if match: slug = match[1]
    match = re.fullmatch(r'/projects/([^/]+)/.+', path)
    if match: slug = match[1]
    if path.startswith('/project/') or path == '/index.html':
        slug = data.get('default_project')
    match = re.fullmatch(r'/collab(?:-runtime)?/paper-workspace:[^/]+:([^/:]+)', path)
    if match: slug = match[1]
    match = re.fullmatch(r'/api/backups/(?:projects|assets|activity)/([^/]+)(?:/.*)?', path)
    if match:
        slug = next((s for s, p in data['projects'].items() if p['backup_id'] == match[1]), None)
        if slug is None: return None
    if slug is not None:
        role = roles.get(slug)
        return role if role and (method in ('GET', 'HEAD') or role in ('owner', 'editor')) else None
    # Compiler/Codex operate on request-supplied source only. Persistent source reads
    # are separately guarded above; rendering never writes a project source.
    if path in ('/api/compile', '/api/package', '/api/synctex', '/api/synctex-view'):
        return 'member' if method == 'POST' and roles else None
    if path == '/api/codex':
        return 'editor' if method == 'POST' and any(r in ('owner', 'editor') for r in roles.values()) else None
    # Only application assets, never arbitrary nginx fallback routes or runtime files.
    if method in ('GET', 'HEAD') and (re.fullmatch(r'/[A-Za-z0-9_-]+\.(?:js|css)', path) or path.startswith(('/vendor/', '/assets/'))):
        return 'member'
    return None


def catalog(data, name):
    payload = json.loads(Path(CATALOG).read_text())
    allowed = memberships(data, name)
    return {'projects': [p for p in payload.get('projects', []) if p.get('slug') in allowed]}
