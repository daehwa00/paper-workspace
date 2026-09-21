from __future__ import annotations
import importlib.util
from pathlib import Path
import pytest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location('personal_accounts', ROOT / 'apps/paper_workspace/password_gate/accounts.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

@pytest.fixture
def registry():
    return {'users': {'alice': {'password_hash': a.password_hash('a long private password')}, 'bob': {'password_hash': a.password_hash('another private password')}},
            'projects': {'first': {'backup_id': 'first-backup', 'members': {'alice': 'owner'}}, 'second': {'backup_id': 'second-backup', 'members': {'bob': 'owner', 'alice': 'viewer'}}}, 'default_project': 'first'}

def test_password_and_revocable_sessions(registry):
    assert a.authenticate(registry, 'alice', 'a long private password')
    assert not a.authenticate(registry, 'bob', 'a long private password')
    assert not a.authenticate(registry, 'missing', 'a long private password')
    token = a.issue(registry, 'alice', 'secret', 60, now=100)
    cookie = 'paper_session=' + token
    assert a.session(registry, cookie, 'secret', now=159) == 'alice'
    assert a.session(registry, cookie, 'secret', now=160) is None
    assert a.session(registry, cookie + 'x', 'secret', now=110) is None
    registry['users']['alice']['disabled'] = True
    assert a.session(registry, cookie, 'secret', now=110) is None

@pytest.mark.parametrize('path', ['/p/first', '/p/first/project/main.tex', '/projects/first/thumbnail.png', '/project/main.tex', '/index.html', '/api/backups/projects/first-backup/assets/x.pdf', '/api/backups/projects/first-backup/snapshots/1', '/collab/paper-workspace:paper.glowme.kr:first', '/collab-runtime/paper-workspace:paper.glowme.kr:first'])
def test_foreign_project_denied(registry, path):
    assert a.authorize(registry, 'bob', path, 'GET') is None
    assert a.authorize(registry, 'alice', path, 'GET') == 'owner'

@pytest.mark.parametrize('path', ['/api/backups/projects/second-backup/snapshots', '/api/backups/projects/second-backup/assets/x', '/api/backups/projects/second-backup/activity', '/collab-runtime/paper-workspace:paper.glowme.kr:second'])
def test_viewer_cannot_write(registry, path):
    assert a.authorize(registry, 'alice', path, 'POST') is None
    assert a.authorize(registry, 'alice', path, 'DELETE') is None
    assert a.authorize(registry, 'bob', path, 'POST') == 'owner'

@pytest.mark.parametrize('path', ['/project-runtime/project/main.tex', '/generated-thumbnails/first/thumbnail.png', '/projects/first/../second/main.tex', '/projects/first/%2e%2e/second/main.tex', '/projects/first/%252e%252e/main.tex', '/alice', '/unknown.html', '/assets/../project/main.tex', '//project/main.tex'])
def test_no_fallback_or_encoding_bypass(registry, path):
    assert a.authorize(registry, 'bob', path, 'GET') is None

def test_catalog_filter_and_password_reset(registry, tmp_path, monkeypatch):
    file = tmp_path / 'index.json'; file.write_text('{"projects":[{"slug":"first"},{"slug":"second"}]}')
    monkeypatch.setattr(a, 'CATALOG', str(file))
    assert a.catalog(registry, 'bob') == {'projects': [{'slug': 'second'}]}
    token = a.issue(registry, 'alice', 'secret', 60, now=100)
    registry['users']['alice']['password_hash'] = a.password_hash('replacement password')
    assert a.session(registry, 'paper_session=' + token, 'secret', now=110) is None

def test_http_login_identity_headers_and_empty_activity_scope(registry, tmp_path, monkeypatch):
    import http.client
    import json
    import threading
    from urllib.parse import urlencode
    spec = importlib.util.spec_from_file_location('personal_gate_http', ROOT / 'apps/paper_workspace/password_gate/server.py')
    gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    registry['users']['empty'] = {'password_hash': a.password_hash('empty account password')}
    file = tmp_path / 'accounts.json'; file.write_text(json.dumps(registry))
    monkeypatch.setattr(gate.accounts, 'REGISTRY', str(file))
    monkeypatch.setattr(gate, 'SESSION_SECRET', 'private session secret with enough entropy')
    server = gate.ThreadingHTTPServer(('127.0.0.1', 0), gate.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        connection = http.client.HTTPConnection(*server.server_address)
        connection.request('POST', '/login', urlencode({'username': 'empty', 'password': 'empty account password'}), {'Content-Type': 'application/x-www-form-urlencoded'})
        response = connection.getresponse(); response.read()
        assert response.status == 303
        assert response.getheader('Location') == '/empty'
        cookie = next(value for key, value in response.getheaders() if key.lower() == 'set-cookie' and value.startswith('paper_session='))
        connection.request('GET', '/verify', headers={'Cookie': cookie, 'X-Forwarded-Uri': '/api/backups/activity', 'X-Forwarded-Method': 'GET'})
        response = connection.getresponse(); response.read()
        assert response.status == 200
        assert response.getheader('X-Paper-Actor') == 'empty'
        assert response.getheader('X-Paper-Allowed-Projects') == '-'
        connection.request('GET', '/verify', headers={'Cookie': cookie, 'X-Forwarded-Uri': '/p/first', 'X-Paper-Actor': 'alice'})
        response = connection.getresponse(); response.read()
        assert response.status == 403
        connection.request('GET', '/context.js', headers={'Cookie': cookie})
        response = connection.getresponse(); body = response.read()
        assert response.getheader('Cache-Control') == 'no-store'
        assert b'"user": "empty"' in body and b'password' not in body
        connection.close()
    finally:
        server.shutdown(); server.server_close(); thread.join()
